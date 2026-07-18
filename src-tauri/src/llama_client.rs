//! Thin async client for llama-server's OpenAI-compatible HTTP API.
//!
//! Bonsai (Qwen3.6 backbone) is a *thinking* model: with thinking enabled the
//! server streams reasoning tokens in `delta.reasoning_content` and the final
//! answer in `delta.content` (two separate channels). We surface both to the
//! UI, and — when requested — a per-token uncertainty signal derived from the
//! streamed logprobs (surprisal / entropy / margin), which is the measured
//! input for the generative visualization and a live confidence readout.

use anyhow::{anyhow, Result};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::think_strip::strip_think;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Per-request sampling + mode, supplied by the frontend settings.
#[derive(Debug, Clone, Deserialize)]
pub struct GenParams {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
    pub max_tokens: u32,
    pub thinking: bool,
}

/// Per-token uncertainty, derived from streamed logprobs. `surprisal` is the
/// negative log-prob of the chosen token(s) in a chunk; `entropy` is over the
/// returned top-k (a lower bound on true entropy); `margin` is top1−top2 logprob
/// (small ⇒ the model was near a coin-flip = a genuine decision point).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct TokenStat {
    pub surprisal: f64,
    pub entropy: f64,
    pub margin: f64,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    timings: Option<Timings>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
    #[serde(default)]
    logprobs: Option<LogProbs>,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct LogProbs {
    #[serde(default)]
    content: Vec<TokenLogprob>,
}

#[derive(Debug, Deserialize)]
struct TokenLogprob {
    #[serde(default)]
    logprob: f64,
    #[serde(default)]
    top_logprobs: Vec<TopLogprob>,
}

#[derive(Debug, Deserialize)]
struct TopLogprob {
    #[serde(default)]
    logprob: f64,
}

#[derive(Debug, Deserialize, Default)]
struct Timings {
    #[serde(default)]
    predicted_per_second: Option<f64>,
    #[serde(default)]
    predicted_n: Option<u32>,
}

/// Aggregate the logprobs attached to one SSE chunk into a single TokenStat.
/// Chunks are ~1 token, so this is effectively per-token; when a chunk carries
/// several tokens we sum surprisal, average entropy, and keep the tightest
/// (most uncertain) margin.
fn chunk_stat(lp: &Option<LogProbs>) -> Option<TokenStat> {
    let lp = lp.as_ref()?;
    if lp.content.is_empty() {
        return None;
    }
    let n = lp.content.len() as f64;
    let mut surprisal = 0.0;
    let mut entropy = 0.0;
    let mut margin = f64::INFINITY;
    for t in &lp.content {
        surprisal += -t.logprob;
        let mut h = 0.0;
        for tp in &t.top_logprobs {
            let p = tp.logprob.exp();
            if p > 0.0 {
                h -= p * p.ln();
            }
        }
        entropy += h;
        let m = if t.top_logprobs.len() >= 2 {
            t.top_logprobs[0].logprob - t.top_logprobs[1].logprob
        } else {
            0.0
        };
        if m < margin {
            margin = m;
        }
    }
    Some(TokenStat {
        surprisal,
        entropy: entropy / n,
        margin: if margin.is_finite() { margin } else { 0.0 },
    })
}

/// Result of a streamed generation.
pub struct StreamResult {
    pub content: String,
    pub reasoning: String,
    pub stopped: bool,
    pub tps: Option<f64>,
    pub tokens: u32,
    pub answer_stats: Vec<TokenStat>,
    pub reasoning_stats: Vec<TokenStat>,
    pub mean_surprisal: Option<f64>,
    pub peak_surprisal: Option<f64>,
}

#[derive(Clone)]
pub struct LlamaClient {
    /// Shared so the base URL can be repointed at a different port after the
    /// startup identity check, without rebuilding the client / http pool.
    base_url: Arc<RwLock<String>>,
    http: reqwest::Client,
}

impl LlamaClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(1800))
            .build()
            .expect("reqwest client");
        Self {
            base_url: Arc::new(RwLock::new(base_url.into())),
            http,
        }
    }

    /// Clone the current base URL (never hold the guard across an await).
    fn base(&self) -> String {
        self.base_url.read().unwrap().clone()
    }

    /// Repoint the client (used when the preferred port was taken by a foreign
    /// server and we spawned our own elsewhere).
    pub fn set_base_url(&self, url: impl Into<String>) {
        *self.base_url.write().unwrap() = url.into();
    }

    /// Fast health probe (600ms budget). True iff the server answers /health 200.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/health", self.base());
        let probe = self
            .http
            .get(&url)
            .timeout(Duration::from_millis(600))
            .send()
            .await;
        matches!(probe, Ok(r) if r.status().is_success())
    }

    /// Identify what model the reachable server is actually serving, so we don't
    /// silently attach to some other OpenAI-compatible process on the same port
    /// (LM Studio, Ollama's shim, a stray llama-server on a different model).
    /// Returns the served model id/path, if the server exposes it.
    pub async fn server_model_id(&self) -> Option<String> {
        let base = self.base();
        if let Ok(resp) = self
            .http
            .get(format!("{base}/v1/models"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let Some(id) = v["data"].get(0).and_then(|m| m["id"].as_str()) {
                    return Some(id.to_string());
                }
            }
        }
        if let Ok(resp) = self
            .http
            .get(format!("{base}/props"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                for ptr in ["/model_path", "/default_generation_settings/model", "/model"] {
                    if let Some(p) = v.pointer(ptr).and_then(|x| x.as_str()) {
                        return Some(p.to_string());
                    }
                }
            }
        }
        None
    }

    /// Stream a chat completion. `on_reasoning`/`on_answer` receive
    /// (text_delta, optional per-token stat). `is_cancelled` is polled between
    /// chunks — when it returns true we stop early (Stop button).
    pub async fn chat_stream<FR, FA, FC>(
        &self,
        messages: Vec<ChatMessage>,
        params: GenParams,
        mut on_reasoning: FR,
        mut on_answer: FA,
        is_cancelled: FC,
    ) -> Result<StreamResult>
    where
        FR: FnMut(&str, Option<TokenStat>) + Send,
        FA: FnMut(&str, Option<TokenStat>) + Send,
        FC: Fn() -> bool + Send,
    {
        let mut body = json!({
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
            "logprobs": true,
            "top_logprobs": 5,
            "temperature": params.temperature,
            "top_p": params.top_p,
            "top_k": params.top_k,
            "max_tokens": params.max_tokens,
        });
        if !params.thinking {
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        }

        let base = self.base();
        let resp = self
            .http
            .post(format!("{base}/v1/chat/completions"))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("llama-server returned {}: {}", status, text));
        }

        let mut stream = resp.bytes_stream().eventsource();
        let mut answer = String::new();
        let mut reasoning = String::new();
        let mut answer_stats: Vec<TokenStat> = Vec::new();
        let mut reasoning_stats: Vec<TokenStat> = Vec::new();
        let mut stopped = false;
        let mut tps: Option<f64> = None;
        let mut tokens: u32 = 0;

        while let Some(event) = stream.next().await {
            if is_cancelled() {
                stopped = true;
                break;
            }
            let event = match event {
                Ok(e) => e,
                Err(_) => continue,
            };
            if event.data == "[DONE]" {
                break;
            }
            let chunk: StreamChunk = match serde_json::from_str(&event.data) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Some(t) = chunk.timings {
                if t.predicted_per_second.is_some() {
                    tps = t.predicted_per_second;
                }
                if let Some(n) = t.predicted_n {
                    tokens = n;
                }
            }
            if let Some(choice) = chunk.choices.first() {
                let stat = chunk_stat(&choice.logprobs);
                if let Some(rc) = &choice.delta.reasoning_content {
                    if !rc.is_empty() {
                        reasoning.push_str(rc);
                        if let Some(s) = stat {
                            reasoning_stats.push(s);
                        }
                        on_reasoning(rc, stat);
                    }
                }
                if let Some(c) = &choice.delta.content {
                    if !c.is_empty() {
                        answer.push_str(c);
                        if let Some(s) = stat {
                            answer_stats.push(s);
                        }
                        on_answer(c, stat);
                    }
                }
            }
        }

        // Defense-in-depth: strip any stray <think> that leaked into content.
        let clean = strip_think(&answer);
        let final_content = if clean.len() != answer.len() {
            clean.trim().to_string()
        } else {
            answer
        };

        let (mean_surprisal, peak_surprisal) = if answer_stats.is_empty() {
            (None, None)
        } else {
            let sum: f64 = answer_stats.iter().map(|s| s.surprisal).sum();
            let peak = answer_stats
                .iter()
                .map(|s| s.surprisal)
                .fold(f64::MIN, f64::max);
            (Some(sum / answer_stats.len() as f64), Some(peak))
        };

        Ok(StreamResult {
            content: final_content,
            reasoning: reasoning.trim().to_string(),
            stopped,
            tps,
            tokens,
            answer_stats,
            reasoning_stats,
            mean_surprisal,
            peak_surprisal,
        })
    }
}
