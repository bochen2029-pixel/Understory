//! Tauri command surface exposed to the React frontend.

use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::llama_client::{ChatMessage, GenParams, TokenStat};
use crate::AppState;

#[derive(Serialize)]
pub struct StatusInfo {
    pub ready: bool,
    pub status: String,
    pub model: String,
    pub ctx: u32,
    pub owns_server: bool,
}

/// Frontend polls this on mount and after ready/status events.
#[tauri::command]
pub async fn get_status(app: AppHandle) -> Result<StatusInfo, String> {
    let st = app.state::<AppState>();
    let ready = st.ready.load(Ordering::Relaxed);
    let status = st.status_msg.lock().unwrap().clone();
    let model = st.model_label.lock().unwrap().clone();
    let ctx = st.ctx_size;
    let owns_server = st.owns_server.load(Ordering::Relaxed);
    Ok(StatusInfo {
        ready,
        status,
        model,
        ctx,
        owns_server,
    })
}

/// Cancel any in-flight generation.
#[tauri::command]
pub async fn stop_generation(app: AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    st.stop_epoch.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize)]
pub struct AssistantReply {
    pub content: String,
    pub reasoning: String,
    pub stopped: bool,
    pub tps: Option<f64>,
    pub tokens: u32,
    /// Per-token uncertainty over the answer / reasoning channels (in-memory;
    /// the generative tree and the uncertainty readout consume these).
    pub answer_stats: Vec<TokenStat>,
    pub reasoning_stats: Vec<TokenStat>,
    pub mean_surprisal: Option<f64>,
    pub peak_surprisal: Option<f64>,
}

/// Stream a reply. Tokens are emitted live as events keyed by `request_id`:
///   bonsai://reasoning  { id, t, st? }   thinking delta (+ per-token stat)
///   bonsai://token      { id, t, st? }   answer delta   (+ per-token stat)
///   bonsai://done       { id, stopped, tps, tokens, mean_surprisal, peak_surprisal }
///   bonsai://error      { id, error }
/// The awaited return value carries the final assembled reply + full stat arrays.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    params: GenParams,
    request_id: String,
) -> Result<AssistantReply, String> {
    let (client, stop_epoch, start_epoch, ready) = {
        let st = app.state::<AppState>();
        (
            st.client.clone(),
            st.stop_epoch.clone(),
            st.stop_epoch.load(Ordering::SeqCst),
            st.ready.load(Ordering::Relaxed),
        )
    };

    if !ready {
        return Err("Model is still loading — please wait for it to finish starting.".into());
    }

    let app_r = app.clone();
    let rid_r = request_id.clone();
    let on_reasoning = move |s: &str, st: Option<TokenStat>| {
        let _ = app_r.emit(
            "bonsai://reasoning",
            serde_json::json!({ "id": rid_r, "t": s, "st": st }),
        );
    };

    let app_a = app.clone();
    let rid_a = request_id.clone();
    let on_answer = move |s: &str, st: Option<TokenStat>| {
        let _ = app_a.emit(
            "bonsai://token",
            serde_json::json!({ "id": rid_a, "t": s, "st": st }),
        );
    };

    let cancel_epoch = stop_epoch.clone();
    let is_cancelled = move || cancel_epoch.load(Ordering::SeqCst) != start_epoch;

    match client
        .chat_stream(messages, params, on_reasoning, on_answer, is_cancelled)
        .await
    {
        Ok(r) => {
            let _ = app.emit(
                "bonsai://done",
                serde_json::json!({
                    "id": request_id,
                    "stopped": r.stopped,
                    "tps": r.tps,
                    "tokens": r.tokens,
                    "mean_surprisal": r.mean_surprisal,
                    "peak_surprisal": r.peak_surprisal,
                }),
            );
            Ok(AssistantReply {
                content: r.content,
                reasoning: r.reasoning,
                stopped: r.stopped,
                tps: r.tps,
                tokens: r.tokens,
                answer_stats: r.answer_stats,
                reasoning_stats: r.reasoning_stats,
                mean_surprisal: r.mean_surprisal,
                peak_surprisal: r.peak_surprisal,
            })
        }
        Err(e) => {
            let _ = app.emit(
                "bonsai://error",
                serde_json::json!({ "id": request_id, "error": e.to_string() }),
            );
            Err(e.to_string())
        }
    }
}
