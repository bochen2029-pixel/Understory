// Hide the console window in release; keep it in debug for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod llama_client;
mod sidecar;
mod think_strip;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tokio::process::Child;
use tracing_subscriber::EnvFilter;

/// llama-server context window. Bonsai supports 262144, but we default to a
/// modest window that keeps peak VRAM tiny (KV cache ~ a few hundred MB here)
/// while being plenty for interactive chat. Raise via ctx_size if desired.
const CTX_SIZE: u32 = 16384;

pub struct AppState {
    pub client: Arc<llama_client::LlamaClient>,
    /// The llama-server child — `Some` only when *this* process spawned it
    /// (so we don't kill a server the user started independently).
    pub llama_child: Mutex<Option<Child>>,
    /// Bumped by `stop_generation` to cancel an in-flight stream.
    pub stop_epoch: Arc<AtomicU64>,
    pub ready: Arc<AtomicBool>,
    pub owns_server: Arc<AtomicBool>,
    pub status_msg: Mutex<String>,
    pub model_label: Mutex<String>,
    pub ctx_size: u32,
}

fn main() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("bonsai=info,llama=info")),
        )
        .try_init();

    tauri::Builder::default()
        .setup(|app| {
            // Managed state is available synchronously (the client is cheap —
            // just a base URL + http pool), so commands can read status even
            // before the server finishes loading.
            app.manage(AppState {
                client: Arc::new(llama_client::LlamaClient::new(format!(
                    "http://127.0.0.1:{}",
                    sidecar::PORT
                ))),
                llama_child: Mutex::new(None),
                stop_epoch: Arc::new(AtomicU64::new(0)),
                ready: Arc::new(AtomicBool::new(false)),
                owns_server: Arc::new(AtomicBool::new(false)),
                status_msg: Mutex::new("Starting…".into()),
                model_label: Mutex::new(String::new()),
                ctx_size: CTX_SIZE,
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = init(handle.clone()).await {
                    tracing::error!("init failed: {e:#}");
                    if let Some(st) = handle.try_state::<AppState>() {
                        *st.status_msg.lock().unwrap() = format!("Startup failed: {e}");
                    }
                    let _ = handle.emit("bonsai://init-error", e.to_string());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Kill the llama-server we own so it doesn't linger after the
                // GUI closes. kill_on_drop also covers hard exits.
                if let Some(st) = window.app_handle().try_state::<AppState>() {
                    if let Some(mut child) = st.llama_child.lock().unwrap().take() {
                        let _ = child.start_kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_message,
            commands::stop_generation,
            commands::get_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bonsai");
}

async fn init(app: AppHandle) -> anyhow::Result<()> {
    // Reuse an already-healthy server (a manually launched one, or a leftover)
    // instead of spawning a second copy that would double VRAM use.
    let client = {
        let st = app.state::<AppState>();
        st.client.clone()
    };

    if client.health_check().await {
        tracing::info!("existing llama-server detected on :{} — reusing", sidecar::PORT);
        let st = app.state::<AppState>();
        *st.status_msg.lock().unwrap() = "Reusing running server".into();
        *st.model_label.lock().unwrap() = sidecar::model_label();
        st.owns_server.store(false, Ordering::Relaxed);
    } else {
        let msg = "Loading Bonsai-27B (1-bit) onto GPU…".to_string();
        {
            let st = app.state::<AppState>();
            *st.status_msg.lock().unwrap() = msg.clone();
        }
        let _ = app.emit("bonsai://status", msg);

        let ctx = {
            let st = app.state::<AppState>();
            st.ctx_size
        };
        let child = sidecar::spawn_llama_server(ctx).await?;

        let st = app.state::<AppState>();
        *st.llama_child.lock().unwrap() = Some(child);
        st.owns_server.store(true, Ordering::Relaxed);
        *st.model_label.lock().unwrap() = sidecar::model_label();
    }

    let (label, owns, ctx) = {
        let st = app.state::<AppState>();
        st.ready.store(true, Ordering::Relaxed);
        *st.status_msg.lock().unwrap() = "Ready".into();
        // Bind lock-clones to locals so their guards drop before `st`.
        let label = st.model_label.lock().unwrap().clone();
        let owns = st.owns_server.load(Ordering::Relaxed);
        let ctx = st.ctx_size;
        (label, owns, ctx)
    };

    let _ = app.emit(
        "bonsai://ready",
        serde_json::json!({ "model": label, "owns": owns, "ctx": ctx }),
    );
    tracing::info!("Bonsai ready (model={label}, owns_server={owns}, ctx={ctx})");
    Ok(())
}
