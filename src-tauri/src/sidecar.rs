//! Owns the local llama.cpp (PrismML build) server process lifecycle.
//!
//! Bonsai-27B-Q1_0 is a custom 1-bit "Q1_0_g128" hybrid-attention GGUF that
//! only the PrismML fork of llama.cpp can execute (custom CUDA/Metal kernels).
//! We therefore point at the dedicated build at C:\llama.cpp-bonsai, NOT the
//! stock C:\llama.cpp (which would fail to load the arch/quant).

use anyhow::{anyhow, Result};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Preferred port. We try this first; if it's taken (or held by a different
/// model — see the identity check in `main::init`) we scan upward for a free one.
pub const PORT: u16 = 8080;

/// Dedicated PrismML llama.cpp build (Q1_0_g128 hybrid-attention kernels).
const LLAMA_DIR: &str = r"C:\llama.cpp-bonsai";
/// Canonical model store on this machine.
const MODEL_DIR: &str = r"C:\models";
/// The 1-bit Bonsai weight pack (~3.8 GB).
const MODEL_FILE: &str = "Bonsai-27B-Q1_0.gguf";

/// Locate `llama-server.exe`. Order: explicit env override → the dedicated
/// PrismML build dir → a bundled copy next to the app exe → stock llama.cpp
/// (last resort; will likely fail on the Q1_0 arch but surfaces a clear error).
fn llama_server_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("BONSAI_LLAMA_SERVER") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from(LLAMA_DIR).join("llama-server.exe")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("llama-bonsai").join("llama-server.exe"));
            candidates.push(dir.join("llama-server.exe"));
        }
    }
    candidates.push(PathBuf::from(r"C:\llama.cpp\llama-server.exe"));

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(anyhow!(
        "llama-server.exe not found. Expected the PrismML build at {}\\llama-server.exe. \
         Set BONSAI_LLAMA_SERVER to override.",
        LLAMA_DIR
    ))
}

/// Resolve the Bonsai GGUF: env override → canonical path → any *bonsai*.gguf
/// found in the model store.
pub fn model_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("BONSAI_MODEL") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    let primary = PathBuf::from(MODEL_DIR).join(MODEL_FILE);
    if primary.exists() {
        return Ok(primary);
    }
    if let Ok(rd) = std::fs::read_dir(MODEL_DIR) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.contains("bonsai") && name.ends_with(".gguf") && !name.contains("mmproj") {
                return Ok(e.path());
            }
        }
    }
    Err(anyhow!(
        "Bonsai model not found at {}\\{}. Set BONSAI_MODEL to override.",
        MODEL_DIR,
        MODEL_FILE
    ))
}

/// Display label for the active model (file name only).
pub fn model_label() -> String {
    model_path()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| MODEL_FILE.to_string())
}

/// A substring that should appear in the served model's id/path when the thing
/// listening is actually our model (used by the identity check before reuse).
pub const MODEL_MATCH: &str = "bonsai";

/// Find a bindable TCP port at or above `start` (scans a small range). Used
/// when the preferred port is occupied by something else so we never collide.
pub fn pick_free_port(start: u16) -> u16 {
    for p in start..start.saturating_add(60) {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    start
}

/// Spawn the llama-server on `port` with the Bonsai model, put it under a
/// kill-on-close Job Object, and wait until it is /health-ready.
///
/// Args are exactly those verified to load Bonsai-27B-Q1_0 on this box
/// (RTX 4070 Ti SUPER, CUDA): full GPU offload, the model's bundled Qwen3.6
/// chat template via --jinja, and the card's recommended sampling defaults.
/// Per-request sampling still overrides these.
pub async fn spawn_llama_server(ctx_size: u32, port: u16) -> Result<Child> {
    let server = llama_server_path()?;
    let server_dir = server
        .parent()
        .ok_or_else(|| anyhow!("llama-server has no parent directory"))?
        .to_path_buf();
    let model = model_path()?;

    tracing::info!("llama-server: {}", server.display());
    tracing::info!("model: {}", model.display());
    tracing::info!("port: {}  ctx-size: {}", port, ctx_size);

    let ctx_str = ctx_size.to_string();
    let port_str = port.to_string();

    let mut cmd = Command::new(&server);
    cmd.current_dir(&server_dir)
        .args([
            "--model",
            &model.to_string_lossy(),
            "--ctx-size",
            &ctx_str,
            "--n-gpu-layers",
            "99",
            "--port",
            &port_str,
            "--host",
            "127.0.0.1",
            "--temp",
            "0.7",
            "--top-p",
            "0.95",
            "--top-k",
            "20",
            "--jinja",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Suppress the console window when the GUI spawns the server.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("failed to spawn llama-server at {}: {}", server.display(), e))?;

    // The child inherits this process's kill-on-close Job Object (installed at
    // startup in `job::install_kill_on_close`), so a crash of THIS process
    // can't orphan a VRAM-holding server.

    // Pump both pipes into tracing (target "llama"), and keep the last stderr
    // lines so a failed launch can surface the actual cause.
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "llama", "{}", line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "llama", "{}", line);
            }
        });
    }

    wait_for_ready(port).await?;
    Ok(child)
}

// NOTE: `creation_flags` is an inherent method on tokio::process::Command under
// #[cfg(windows)] — no extension trait import required.

/// Block until the server answers /health 200 on `port`, or 180s elapse.
async fn wait_for_ready(port: u16) -> Result<()> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(180);
    let url = format!("http://127.0.0.1:{}/health", port);
    loop {
        if Instant::now() > deadline {
            return Err(anyhow!("llama-server did not become ready within 180s"));
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                tracing::info!("llama-server ready on :{}", port);
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
