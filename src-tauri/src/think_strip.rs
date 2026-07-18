// Defense-in-depth strip for <think>...</think> blocks emitted by Qwen3.5's
// chat template. The OpenAI-compat `chat_template_kwargs.enable_thinking:
// false` switch is not honored by the GGUF's chat template (verified in
// dev.log: `init: chat template, thinking = 1` at server startup), so the
// model produces think tags even when we asked for them off. Same A7 pattern
// as the harness-leak filter — strip at the SDK boundary so consumers see
// clean text regardless of model template behavior.
//
// Handles:
// - Empty pairs:        <think></think>      → ""
// - Content pairs:      <think>foo</think>   → ""
// - Surrounding text:   a<think>x</think>b   → "ab" (with optional trailing
//                                                    whitespace eaten after
//                                                    </think>)
// - Streaming chunks: tokens may split a tag mid-character.
//   The stripper buffers any partial `<think...` open OR partial `</think...`
//   close until disambiguated. Streamed callers see only complete, cleaned
//   prefixes.

const OPEN: &str = "<think";
const CLOSE: &str = "</think>";

/// Remove all complete `<think>...</think>` blocks from a fully-buffered
/// string. If the string ends mid-tag (open or close not yet closed), the
/// trailing partial is dropped from the returned visible portion AND signaled
/// via the second return value (raw_consumed_up_to) so streaming callers can
/// remember how much input is "decided." Non-streaming callers ignore the
/// second value.
pub fn strip_think(input: &str) -> String {
    let (visible, _consumed) = strip_think_with_consumed(input);
    visible
}

/// Returns (visible_text, raw_input_consumed_through_byte_offset).
/// `raw_input_consumed_through_byte_offset` is the index up to which the
/// stripper has made a final decision. Anything after that offset is held
/// back (e.g., a partially-seen `<th` that may or may not become `<think`).
fn strip_think_with_consumed(input: &str) -> (String, usize) {
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let bytes = input.as_bytes();

    while i < bytes.len() {
        // Find the next plausible start of a tag (either `<think` open or
        // a `<` we don't yet know about).
        let next_lt = match input[i..].find('<') {
            Some(rel) => i + rel,
            None => {
                // No more tags; emit the rest.
                out.push_str(&input[i..]);
                return (out, bytes.len());
            }
        };

        // Emit anything before the `<` that's safe.
        out.push_str(&input[i..next_lt]);
        i = next_lt;

        // Could this `<` start `<think`? Compare what we have against
        // the OPEN prefix. If we already have enough bytes to disprove,
        // emit literally. If we don't have enough but what we have is a
        // prefix of `<think`, hold back. Otherwise emit literally.
        let remaining = &input[i..];
        let cmp_len = OPEN.len().min(remaining.len());
        let prefix_matches = remaining[..cmp_len].eq_ignore_ascii_case(&OPEN[..cmp_len]);

        if !prefix_matches {
            // Disproved — `<` is followed by something that isn't `<think`.
            out.push('<');
            i += 1;
            continue;
        }

        if remaining.len() < OPEN.len() {
            // Could still become `<think`; hold back to wait for more bytes.
            return (out, i);
        }

        // Confirmed: this is the start of a think open tag. Find the `>`
        // that closes the open tag. If we don't see one yet, hold back.
        let after_open_prefix = i + OPEN.len();
        let close_of_open = match input[after_open_prefix..].find('>') {
            Some(rel) => after_open_prefix + rel + 1,
            None => return (out, i), // open tag not closed yet
        };

        // Now find the matching `</think>`. If we don't see one yet, hold
        // back from i (don't reveal anything inside or before the open).
        let close_idx = match input[close_of_open..].find(CLOSE) {
            Some(rel) => close_of_open + rel,
            None => return (out, i),
        };

        let end_of_close = close_idx + CLOSE.len();

        // Skip the entire <think>...</think> block. Also eat trailing
        // whitespace/newlines that typically follow a Qwen think block
        // ("<think>...</think>\n\n[content]") so the visible text doesn't
        // start with leading blank lines.
        i = end_of_close;
        while i < bytes.len() && (bytes[i] == b'\n' || bytes[i] == b'\r' || bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
    }

    (out, bytes.len())
}

/// Streaming-friendly stripper. Maintains a buffer across pushes. Each push
/// returns the new visible text (delta) that the caller should emit since
/// the previous push.
pub struct ThinkStripper {
    raw: String,
    emitted_visible_chars: usize,
}

impl ThinkStripper {
    pub fn new() -> Self {
        Self {
            raw: String::new(),
            emitted_visible_chars: 0,
        }
    }

    /// Append a new chunk of raw model output. Returns the new visible
    /// portion the caller should emit (may be empty if the chunk is
    /// entirely inside a think block or held back as a partial tag).
    pub fn push(&mut self, chunk: &str) -> String {
        self.raw.push_str(chunk);
        let visible = strip_think(&self.raw);
        let visible_len = visible.chars().count();
        if visible_len > self.emitted_visible_chars {
            // Compute the delta. We have to re-iterate the chars because
            // visible may have changed in the middle (rare but possible if
            // a tag was retroactively closed); we always emit only the
            // suffix beyond what we previously emitted.
            let new: String = visible
                .chars()
                .skip(self.emitted_visible_chars)
                .collect();
            self.emitted_visible_chars = visible_len;
            new
        } else {
            String::new()
        }
    }

    /// Final cleaned text. Trims trailing whitespace.
    pub fn finalize(self) -> String {
        strip_think(&self.raw).trim().to_string()
    }
}

impl Default for ThinkStripper {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_empty_pair() {
        assert_eq!(strip_think("<think></think>hello"), "hello");
    }

    #[test]
    fn strips_content_pair() {
        assert_eq!(strip_think("<think>reasoning</think>hello"), "hello");
    }

    #[test]
    fn strips_with_leading_whitespace_after() {
        assert_eq!(strip_think("<think>x</think>\n\nactual content"), "actual content");
    }

    #[test]
    fn preserves_text_around() {
        assert_eq!(
            strip_think("before <think>x</think> after"),
            "before after"
        );
    }

    #[test]
    fn no_think_passes_through() {
        assert_eq!(strip_think("just regular content"), "just regular content");
    }

    #[test]
    fn multiple_blocks() {
        assert_eq!(
            strip_think("a<think>1</think>b<think>2</think>c"),
            "abc"
        );
    }

    #[test]
    fn lt_without_think_passes() {
        assert_eq!(strip_think("a<b>c"), "a<b>c");
    }

    #[test]
    fn streaming_split_open_tag() {
        let mut s = ThinkStripper::new();
        assert_eq!(s.push("<th"), "");
        assert_eq!(s.push("ink>"), "");
        assert_eq!(s.push("inner</thi"), "");
        assert_eq!(s.push("nk>after"), "after");
        assert_eq!(s.finalize(), "after");
    }

    #[test]
    fn streaming_emits_pre_text_then_strips() {
        let mut s = ThinkStripper::new();
        let a = s.push("hello ");
        let b = s.push("<think>x</think>world");
        assert_eq!(format!("{}{}", a, b), "hello world");
    }

    #[test]
    fn streaming_empty_pair() {
        let mut s = ThinkStripper::new();
        s.push("<think>");
        s.push("</think>\n\n");
        let final_emit = s.push("the actual reply.");
        assert_eq!(final_emit, "the actual reply.");
    }
}
