// Hide the console window in release; keep it in debug for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod job;
mod llama_client;
mod sidecar;
mod think_strip;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tokio::process::Child;
use tracing_subscriber::EnvFilter;

/// llama-server context window. Bonsai supports 262144; 16384 keeps peak VRAM
/// tiny while being plenty for interactive chat. (Tier-1 hardening will make
/// this a measured, user-set value.)
const CTX_SIZE: u32 = 16384;

pub struct AppState {
    pub client: Arc<llama_client::LlamaClient>,
    /// The llama-server child — `Some` only when *this* process spawned it.
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
        // Single-instance MUST be registered first: a second launch focuses the
        // existing window instead of spawning a duplicate app + sidecar.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // Install the kill-on-close job BEFORE any child spawns, so the
            // llama-server inherits it and can't be orphaned by a crash.
            if let Err(e) = job::install_kill_on_close() {
                tracing::warn!("kill-on-close job not installed (orphan backstop disabled): {e}");
            }

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
                if let Some(st) = window.app_handle().try_state::<AppState>() {
                    if let Some(mut child) = st.llama_child.lock().unwrap().take() {
                        let _ = child.start_kill();
                    }
                    // The inherited kill-on-close job is the backstop for any
                    // path that skips this graceful kill.
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

fn basename(s: &str) -> String {
    s.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(s)
        .to_string()
}

async fn init(app: AppHandle) -> anyhow::Result<()> {
    let (client, ctx) = {
        let st = app.state::<AppState>();
        (st.client.clone(), st.ctx_size)
    };

    if client.health_check().await {
        // Something's on the preferred port — but is it OURS? Don't attach to a
        // stray LM Studio / Ollama / different-model llama-server.
        let id = client.server_model_id().await.unwrap_or_default();
        if id.to_lowercase().contains(sidecar::MODEL_MATCH) {
            tracing::info!("reusing existing Bonsai server on :{} (model={id})", sidecar::PORT);
            let st = app.state::<AppState>();
            *st.status_msg.lock().unwrap() = "Reusing running server".into();
            let label = if id.is_empty() {
                sidecar::model_label()
            } else {
                basename(&id)
            };
            *st.model_label.lock().unwrap() = label;
            st.owns_server.store(false, Ordering::Relaxed);
        } else {
            tracing::warn!(
                ":{} is serving a different model ({id:?}); spawning our own on a free port",
                sidecar::PORT
            );
            spawn_ours(&app, ctx, sidecar::pick_free_port(sidecar::PORT + 1)).await?;
        }
    } else {
        // Nothing healthy on the preferred port; take it if free, else scan up.
        let port = sidecar::pick_free_port(sidecar::PORT);
        spawn_ours(&app, ctx, port).await?;
    }

    let (label, owns, ctx_size) = {
        let st = app.state::<AppState>();
        st.ready.store(true, Ordering::Relaxed);
        *st.status_msg.lock().unwrap() = "Ready".into();
        let label = st.model_label.lock().unwrap().clone();
        let owns = st.owns_server.load(Ordering::Relaxed);
        (label, owns, st.ctx_size)
    };

    let _ = app.emit(
        "bonsai://ready",
        serde_json::json!({ "model": label, "owns": owns, "ctx": ctx_size }),
    );
    tracing::info!("Bonsai ready (model={label}, owns_server={owns}, ctx={ctx_size})");
    Ok(())
}

/// Spawn our own llama-server on `port`, repointing the client if it's not the
/// preferred port, and store the child + job in state.
async fn spawn_ours(app: &AppHandle, ctx: u32, port: u16) -> anyhow::Result<()> {
    let msg = "Loading Bonsai-27B (1-bit) onto GPU…";
    {
        let st = app.state::<AppState>();
        *st.status_msg.lock().unwrap() = msg.into();
        if port != sidecar::PORT {
            st.client.set_base_url(format!("http://127.0.0.1:{port}"));
        }
    }
    let _ = app.emit("bonsai://status", msg);

    let child = sidecar::spawn_llama_server(ctx, port).await?;

    let st = app.state::<AppState>();
    *st.llama_child.lock().unwrap() = Some(child);
    st.owns_server.store(true, Ordering::Relaxed);
    *st.model_label.lock().unwrap() = sidecar::model_label();
    Ok(())
}
