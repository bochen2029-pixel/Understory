//! Thin async client for llama-server's OpenAI-compatible HTTP API.
//!
//! Bonsai (Qwen3.6 backbone) is a *thinking* model: with thinking enabled the
//! server streams reasoning tokens in `delta.reasoning_content` and the final
//! answer in `delta.content` (two separate channels). We surface both to the
//! UI via distinct callbacks so the frontend can show a live, collapsible
//! reasoning panel above the answer.

use anyhow::{anyhow, Result};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
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
    /// When false, we pass `chat_template_kwargs.enable_thinking = false` so
    /// the model answers directly (fast path). When true, the model reasons
    /// first (reasoning_content) then answers (content).
    pub thinking: bool,
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
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Timings {
    #[serde(default)]
    predicted_per_second: Option<f64>,
    #[serde(default)]
    predicted_n: Option<u32>,
}

/// Result of a streamed generation.
pub struct StreamResult {
    pub content: String,
    pub reasoning: String,
    /// True if the user hit Stop mid-generation.
    pub stopped: bool,
    /// Decode throughput (tokens/s), when the server reported timings.
    pub tps: Option<f64>,
    pub tokens: u32,
}

#[derive(Clone)]
pub struct LlamaClient {
    base_url: String,
    http: reqwest::Client,
}

impl LlamaClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(1800))
            .build()
            .expect("reqwest client");
        Self {
            base_url: base_url.into(),
            http,
        }
    }

    /// Fast health probe (600ms budget). True iff the server answers /health 200.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        let probe = self
            .http
            .get(&url)
            .timeout(Duration::from_millis(600))
            .send()
            .await;
        matches!(probe, Ok(r) if r.status().is_success())
    }

    /// Stream a chat completion. `on_reasoning` receives thinking-channel
    /// deltas; `on_answer` receives answer-channel deltas. `is_cancelled` is
    /// polled between chunks — when it returns true we stop early (Stop button).
    pub async fn chat_stream<FR, FA, FC>(
        &self,
        messages: Vec<ChatMessage>,
        params: GenParams,
        mut on_reasoning: FR,
        mut on_answer: FA,
        is_cancelled: FC,
    ) -> Result<StreamResult>
    where
        FR: FnMut(&str) + Send,
        FA: FnMut(&str) + Send,
        FC: Fn() -> bool + Send,
    {
        let mut body = json!({
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
            "temperature": params.temperature,
            "top_p": params.top_p,
            "top_k": params.top_k,
            "max_tokens": params.max_tokens,
        });
        if !params.thinking {
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        }

        let resp = self
            .http
            .post(format!("{}/v1/chat/completions", self.base_url))
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
                if let Some(rc) = &choice.delta.reasoning_content {
                    if !rc.is_empty() {
                        reasoning.push_str(rc);
                        on_reasoning(rc);
                    }
                }
                if let Some(c) = &choice.delta.content {
                    if !c.is_empty() {
                        answer.push_str(c);
                        on_answer(c);
                    }
                }
                if choice.finish_reason.is_some() {
                    // keep draining until [DONE]/timings, but the model is done
                }
            }
        }

        // Defense-in-depth: if any stray <think> leaked into the answer channel
        // (e.g. a template that doesn't route cleanly), strip it from the final.
        let clean = strip_think(&answer);
        let final_content = if clean.len() != answer.len() {
            clean.trim().to_string()
        } else {
            answer
        };

        Ok(StreamResult {
            content: final_content,
            reasoning: reasoning.trim().to_string(),
            stopped,
            tps,
            tokens,
        })
    }
}
