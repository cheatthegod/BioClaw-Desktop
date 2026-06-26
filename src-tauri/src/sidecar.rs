//! Sidecar lifecycle supervisor.
//!
//! Phase-2 minimum: spawn the bundled `bioclaw-sidecar-<triple>.js` binary
//! via tauri-plugin-shell, read its stdout for the `PORT=<N>` line, then
//! expose health-check + shutdown helpers to the Tauri command surface.
//!
//! Process model:
//! ```text
//!   Tauri (Rust)
//!     └─ tauri_plugin_shell::sidecar("bioclaw-sidecar")
//!         └─ node $bundle_path/binaries/bioclaw-sidecar-<triple>.js
//!             ├─ stdout: "PORT=NNNN\nREADY\n..."
//!             └─ stdin:  kept open (closes => child exits, see main.ts)
//! ```
//!
//! Shutdown cascade (in `stop_with_cascade`):
//!   1. `POST http://127.0.0.1:<port>/shutdown` with a 3s timeout (graceful).
//!   2. If still alive, send SIGTERM via the child handle (2s grace).
//!   3. If still alive, SIGKILL (instant).
//!
//! Why through tauri-plugin-shell instead of `std::process::Command`?
//! Tauri 2's capability system gates sidecar spawning under
//! `shell:allow-execute` — a compromised webview can't ask the shell plugin
//! to spawn arbitrary binaries; only the ones in tauri.conf.json's
//! `externalBin` whitelist. Using `std::process` would bypass that gate.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};

/// Name of the bundled sidecar binary, sans target-triple suffix. Tauri
/// resolves this against `tauri.conf.json`'s `bundle.externalBin` entry.
const SIDECAR_NAME: &str = "binaries/bioclaw-sidecar";

/// Max time we wait for the sidecar to print `PORT=...` after spawn. If the
/// process doesn't announce a port within this window we kill it and surface
/// an error to the caller (likely cause: missing Node runtime, bad bundle).
const PORT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);

/// Health-check timeout per attempt. We keep this short so a stuck sidecar
/// doesn't block the UI.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);

/// Graceful shutdown timeout for the `POST /shutdown` step.
const SHUTDOWN_HTTP_TIMEOUT: Duration = Duration::from_secs(3);

/// SIGTERM grace before we escalate to SIGKILL.
const SIGTERM_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

/// Shared mutable state behind the Tauri `State`. We hold the child handle
/// so the Drop-on-app-exit path can issue kill signals.
#[derive(Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    port: Option<u16>,
    pid: Option<u32>,
    child: Option<CommandChild>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn status(&self) -> SidecarStatus {
        let g = self.inner.lock().await;
        SidecarStatus {
            running: g.child.is_some(),
            port: g.port,
            pid: g.pid,
        }
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.child.is_some()
    }

    /// Spawn the sidecar if not already running. Returns the bound port.
    pub async fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Result<u16, String> {
        {
            let g = self.inner.lock().await;
            if let Some(p) = g.port {
                return Ok(p);
            }
        }

        let shell = app.shell();
        // tauri-plugin-shell::sidecar() looks up the binary by its externalBin
        // base name, then appends the host's target triple at runtime.
        let cmd = shell
            .sidecar(SIDECAR_NAME)
            .map_err(|e| format!("sidecar resolve failed (is {SIDECAR_NAME} in externalBin?): {e}"))?;

        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("sidecar spawn failed: {e}"))?;

        let pid = child.pid();

        // Read stdout until we see `PORT=NNNN`, then return. We intentionally
        // keep reading stdout in a background task afterwards so the pipe
        // doesn't fill up and block the child.
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<Result<u16, String>>();
        let mut port_tx = Some(port_tx);

        let inner_handle = self.inner.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(buf) => {
                        let line = String::from_utf8_lossy(&buf).to_string();
                        log::debug!("sidecar stdout: {}", line.trim_end());
                        if let Some(p) = parse_port_line(&line) {
                            if let Some(tx) = port_tx.take() {
                                let _ = tx.send(Ok(p));
                            }
                        }
                    }
                    CommandEvent::Stderr(buf) => {
                        log::warn!("sidecar stderr: {}", String::from_utf8_lossy(&buf).trim_end());
                    }
                    CommandEvent::Error(e) => {
                        log::error!("sidecar error: {e}");
                        if let Some(tx) = port_tx.take() {
                            let _ = tx.send(Err(e));
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        log::info!("sidecar exited code={:?} signal={:?}", payload.code, payload.signal);
                        if let Some(tx) = port_tx.take() {
                            let _ = tx.send(Err(format!(
                                "sidecar exited before announcing PORT (code={:?})",
                                payload.code
                            )));
                        }
                        // Clear the running-state once the child is gone so
                        // sidecar_status reflects reality.
                        let mut g = inner_handle.lock().await;
                        g.child = None;
                        g.port = None;
                        g.pid = None;
                        break;
                    }
                    _ => {}
                }
            }
        });

        let port = match timeout(PORT_DISCOVERY_TIMEOUT, port_rx).await {
            Ok(Ok(Ok(p))) => p,
            Ok(Ok(Err(e))) => {
                let _ = child.kill();
                return Err(format!("sidecar startup error: {e}"));
            }
            Ok(Err(_recv_err)) => {
                let _ = child.kill();
                return Err("sidecar port channel closed".into());
            }
            Err(_) => {
                let _ = child.kill();
                return Err(format!(
                    "sidecar didn't announce port within {}s",
                    PORT_DISCOVERY_TIMEOUT.as_secs()
                ));
            }
        };

        // Health-check with a couple of short retries; the listener prints
        // PORT before READY but the OS may need a tick to actually accept
        // connections.
        if !health_check_retry(port).await {
            let _ = child.kill();
            return Err(format!("sidecar /health failed on port {port}"));
        }

        {
            let mut g = self.inner.lock().await;
            g.port = Some(port);
            g.pid = Some(pid);
            g.child = Some(child);
        }
        log::info!("sidecar ready: pid={pid} port={port}");
        Ok(port)
    }

    /// Stop the sidecar gracefully, falling back to SIGTERM/SIGKILL.
    pub async fn stop(&self) -> Result<(), String> {
        let (port, child) = {
            let mut g = self.inner.lock().await;
            let port = g.port.take();
            let child = g.child.take();
            g.pid = None;
            (port, child)
        };
        if child.is_none() {
            return Ok(()); // not running
        }
        let child = child.unwrap();
        // Step 1: HTTP shutdown.
        if let Some(p) = port {
            let _ = post_shutdown(p).await;
        }
        // Step 2: SIGTERM grace. tauri-plugin-shell's CommandChild::kill()
        // sends SIGKILL on unix and TerminateProcess on win32 — there's no
        // public SIGTERM helper. We approximate by waiting briefly to see if
        // the HTTP shutdown took effect (the child process exits its event
        // loop on /shutdown). If still alive after the grace period, we kill.
        sleep(SIGTERM_GRACE).await;
        // Step 3: hard kill. Safe to call even if already exited.
        let _ = child.kill();
        Ok(())
    }
}

fn parse_port_line(line: &str) -> Option<u16> {
    for tok in line.split_whitespace() {
        if let Some(rest) = tok.strip_prefix("PORT=") {
            if let Ok(p) = rest.parse::<u16>() {
                return Some(p);
            }
        }
    }
    None
}

async fn health_check_retry(port: u16) -> bool {
    for attempt in 0..10 {
        if health_check(port).await {
            return true;
        }
        sleep(Duration::from_millis(100 * (attempt + 1))).await;
    }
    false
}

async fn health_check(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let fut = async {
        // Tiny ad-hoc HTTP/1.1 GET so we don't need to pull reqwest just for
        // this. The /health response is a small JSON; we only check that
        // 200 OK comes back.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!(
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::with_capacity(256);
        s.read_to_end(&mut buf).await.ok()?;
        let text = String::from_utf8_lossy(&buf);
        if text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200") {
            Some(())
        } else {
            None
        }
    };
    let _ = url; // currently unused but keeps the URL trace handy in logs
    matches!(timeout(HEALTH_TIMEOUT, fut).await, Ok(Some(())))
}

async fn post_shutdown(port: u16) -> Result<(), String> {
    let fut = async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let body = "{}";
        let req = format!(
            "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        s.write_all(req.as_bytes()).await.map_err(|e| format!("write: {e}"))?;
        let mut buf = Vec::with_capacity(128);
        let _ = s.read_to_end(&mut buf).await;
        Ok::<_, String>(())
    };
    match timeout(SHUTDOWN_HTTP_TIMEOUT, fut).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("shutdown HTTP timed out".into()),
    }
}
