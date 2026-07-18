// Minimal, dependency-free markdown → HTML renderer. Escapes first, then
// applies a safe subset (fenced code, inline code, bold/italic, headings).
// Newlines are preserved via `white-space: pre-wrap` on `.md`.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  let t = escapeHtml(text);
  // inline code (protect before other inline rules)
  t = t.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic — only when flanked by whitespace/start to avoid eating * in code
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  // headings
  t = t.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  t = t.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  t = t.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  return t;
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) {
    if (m.index > last) {
      out.push(`<div class="md">${renderInline(src.slice(last, m.index))}</div>`);
    }
    const lang = m[1] || 'text';
    const code = escapeHtml(m[2].replace(/\n$/, ''));
    out.push(
      `<div class="code-wrap"><div class="code-head"><span>${escapeHtml(
        lang,
      )}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${code}</code></pre></div>`,
    );
    last = fence.lastIndex;
  }
  if (last < src.length) {
    out.push(`<div class="md">${renderInline(src.slice(last))}</div>`);
  }
  return out.join('');
}
