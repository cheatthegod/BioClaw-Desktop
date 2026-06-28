//! Env setup driver — orchestrates "first launch / repair".
//!
//! Two paths (same as the Node sidecar):
//!   A. Offline: extract `bioclaw-env.zip` from the resource dir,
//!      then `uv sync --frozen --offline` against the bundled wheel
//!      cache. ~5-10 s end-to-end, zero network. Default when the
//!      installer ships an env zip (Stage K bundled env).
//!   B. Online: copy pyproject + uv.lock from the loose-files bundle,
//!      then `uv python install` + `uv sync` against PyPI. Used for
//!      dev runs without a vendored zip, and for any `--extras`
//!      request (extras aren't baked into the offline cache).
//!
//! Either path emits the same `SetupEvent` stream; the /env/setup
//! SSE handler relays them to the frontend banner without caring
//! which path produced them.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::paths;

/// Streamed setup-progress event. The SSE handler serializes these
/// into `event: <type>\ndata: {...}` lines.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SetupEvent {
    Phase { label: String },
    Log { stream: LogStream, line: String },
    Done,
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Caller-supplied setup parameters.
pub struct SetupOptions<'a> {
    pub project_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
    /// Extras to pass via `--extra <name>` on `uv sync`.
    pub extras: &'a [String],
    /// Optional uv index URL override (Aliyun / TUNA mirror, etc.).
    pub index_url: Option<String>,
    /// Path to the `uv` binary. Resolved by [`resolve_uv_path`].
    pub uv_path: PathBuf,
    /// Cancellation token. Aborting kills the spawned uv subprocess.
    pub abort: tokio_util::sync::CancellationToken,
}

/// Top-level entry — picks A vs B and drives it. Sends events on
/// the supplied `mpsc::Sender`. Returns when the install finishes
/// (success or terminal error). The handler relays events on to
/// the SSE response.
pub async fn run_setup(opts: SetupOptions<'_>, tx: mpsc::Sender<SetupEvent>) -> Result<()> {
    let zip = paths::bundled_env_zip(opts.resource_dir.as_deref());
    let bundled_src = paths::bundled_env_source_dir(opts.resource_dir.as_deref());

    // Add-extra requests always go through the online path — extras
    // aren't baked into the offline cache.
    let want_online = !opts.extras.is_empty();

    if !want_online {
        if let Some(ref z) = zip {
            if z.exists() {
                return run_offline_setup(&opts, z, tx).await;
            }
        }
    }
    if let Some(ref src) = bundled_src {
        return run_online_setup(&opts, src, tx).await;
    }
    // No Error event emitted here — the route handler converts the
    // returned anyhow into the SSE Error event, so emission stays
    // single-source. tx is held but not used in this branch.
    let _ = tx;
    Err(anyhow!(
        "No bundled env: BIOCLAW_RESOURCE_DIR is unset AND no bioclaw-env.zip on disk."
    ))
}

async fn run_offline_setup(
    opts: &SetupOptions<'_>,
    zip: &Path,
    tx: mpsc::Sender<SetupEvent>,
) -> Result<()> {
    let _ = tx
        .send(SetupEvent::Phase {
            label: "Unpacking local Python kernel".into(),
        })
        .await;
    extract_zip(zip, &opts.project_dir, opts.abort.clone())
        .await
        .map_err(|e| anyhow!("Failed to extract bundled env: {e:#}"))?;

    let python_bin = locate_bundled_python(&opts.project_dir).ok_or_else(|| {
        anyhow!(
            "bundled Python not found under {}/_base",
            opts.project_dir.display()
        )
    })?;

    let _ = tx
        .send(SetupEvent::Phase {
            label: "Finalising venv (offline, no network)".into(),
        })
        .await;
    let args = [
        "sync".to_string(),
        "--frozen".to_string(),
        "--offline".to_string(),
        "--python".to_string(),
        python_bin.to_string_lossy().into_owned(),
    ];
    let env_extra = [
        (
            "UV_CACHE_DIR".to_string(),
            opts.project_dir
                .join("_uv-cache")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "UV_PYTHON_INSTALL_DIR".to_string(),
            opts.project_dir
                .join("_base")
                .to_string_lossy()
                .into_owned(),
        ),
    ];
    run_uv(
        &opts.uv_path,
        &args,
        &opts.project_dir,
        &env_extra,
        opts.index_url.as_deref(),
        opts.abort.clone(),
        &tx,
    )
    .await
    .map_err(|e| anyhow!("uv sync (offline) failed: {e:#}"))?;

    let _ = tx.send(SetupEvent::Done).await;
    Ok(())
}

async fn run_online_setup(
    opts: &SetupOptions<'_>,
    bundled_src: &Path,
    tx: mpsc::Sender<SetupEvent>,
) -> Result<()> {
    let _ = tx
        .send(SetupEvent::Phase {
            label: "Initialising project files".into(),
        })
        .await;
    init_project_dir(bundled_src, &opts.project_dir)
        .with_context(|| "failed to seed project dir from bundled source")?;

    let _ = tx
        .send(SetupEvent::Phase {
            label: "Installing Python 3.11 (uv-managed)".into(),
        })
        .await;
    let py_install = [
        "python".to_string(),
        "install".to_string(),
        "3.11".to_string(),
    ];
    run_uv(
        &opts.uv_path,
        &py_install,
        &opts.project_dir,
        &[],
        opts.index_url.as_deref(),
        opts.abort.clone(),
        &tx,
    )
    .await?;

    let mut sync_args = vec!["sync".to_string(), "--frozen".to_string()];
    for e in opts.extras {
        sync_args.push("--extra".into());
        sync_args.push(e.clone());
    }
    let label = if opts.extras.is_empty() {
        "Resolving + installing base packages (downloading wheels)".to_string()
    } else {
        format!(
            "Resolving + installing base + {} (downloading wheels)",
            opts.extras.join(", ")
        )
    };
    let _ = tx.send(SetupEvent::Phase { label }).await;
    run_uv(
        &opts.uv_path,
        &sync_args,
        &opts.project_dir,
        &[],
        opts.index_url.as_deref(),
        opts.abort.clone(),
        &tx,
    )
    .await?;

    let _ = tx.send(SetupEvent::Done).await;
    Ok(())
}

/// Copy `pyproject.toml`, `uv.lock`, `.python-version` from bundle
/// source into project dir. Idempotent.
fn init_project_dir(bundled_src: &Path, project_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(project_dir)?;
    for f in ["pyproject.toml", "uv.lock", ".python-version"] {
        let from = bundled_src.join(f);
        let to = project_dir.join(f);
        if !from.exists() {
            bail!("Bundled env missing {} (looked at {})", f, from.display());
        }
        std::fs::copy(&from, &to)
            .with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
    }
    // README is best-effort.
    let readme = bundled_src.join("README.md");
    if readme.exists() {
        let _ = std::fs::copy(readme, project_dir.join("README.md"));
    }
    Ok(())
}

/// Find the bundled CPython under `<project_dir>/_base/cpython-*/`.
/// uv standalone layout puts the interpreter at:
///   POSIX   `_base/cpython-<ver>-<target>/bin/python3`
///   Windows `_base/cpython-<ver>-<target>/python.exe`
fn locate_bundled_python(project_dir: &Path) -> Option<PathBuf> {
    let base = project_dir.join("_base");
    if !base.exists() {
        return None;
    }
    let entries = std::fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let candidates = [
            p.join("bin").join("python3"),
            p.join("bin").join("python"),
            p.join("python.exe"),
        ];
        if let Some(found) = candidates.into_iter().find(|c| c.exists()) {
            return Some(found);
        }
    }
    None
}

/// Run `uv <args>` in `project_dir`, streaming stdout + stderr line
/// by line to the SSE channel. Aborts on cancellation.
async fn run_uv(
    uv: &Path,
    args: &[String],
    project_dir: &Path,
    extra_env: &[(String, String)],
    index_url: Option<&str>,
    abort: tokio_util::sync::CancellationToken,
    tx: &mpsc::Sender<SetupEvent>,
) -> Result<()> {
    let mut cmd = Command::new(uv);
    cmd.args(args)
        .current_dir(project_dir)
        .env_clear()
        // Minimal env: PATH / HOME / LANG / TMPDIR + NO_COLOR so the
        // streamed log lines are ANSI-free.
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
        )
        .env(
            "HOME",
            std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into()),
        )
        .env(
            "LANG",
            std::env::var_os("LANG").unwrap_or_else(|| "C.UTF-8".into()),
        )
        .env(
            "TMPDIR",
            std::env::var_os("TMPDIR").unwrap_or_else(|| "/tmp".into()),
        )
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(url) = index_url {
        cmd.env("UV_INDEX_URL", url);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    info!(uv = %uv.display(), args = ?args, "spawning uv");
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn uv {}", uv.display()))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let tx_out = tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_out
                .send(SetupEvent::Log {
                    stream: LogStream::Stdout,
                    line,
                })
                .await;
        }
    });
    let tx_err = tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_err
                .send(SetupEvent::Log {
                    stream: LogStream::Stderr,
                    line,
                })
                .await;
        }
    });

    // Wait for either child exit or abort. On abort, kill_on_drop
    // takes care of cleanup (we set kill_on_drop above).
    let status = tokio::select! {
        s = child.wait() => s.context("uv exited unexpectedly")?,
        _ = abort.cancelled() => {
            warn!("setup aborted by client; killing uv subprocess");
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("setup cancelled");
        }
    };

    // Drain the stream readers before returning.
    let _ = tokio::try_join!(stdout_task, stderr_task);

    if !status.success() {
        bail!("uv exited with status {status}");
    }
    Ok(())
}

/// Extract a zip into `dest`. Uses `unzip` on POSIX and `tar.exe`
/// (handles zip on Windows 10+) on Windows. We shell out instead of
/// pulling the `zip` crate because the zip is huge (~250 MB) and a
/// streaming external tool is faster than re-implementing inflate.
async fn extract_zip(
    zip: &Path,
    dest: &Path,
    abort: tokio_util::sync::CancellationToken,
) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("tar");
        c.arg("-xf").arg(zip).arg("-C").arg(dest);
        c
    } else {
        let mut c = Command::new("unzip");
        c.arg("-q").arg("-o").arg(zip).arg("-d").arg(dest);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to spawn extractor")?;

    let status = tokio::select! {
        s = child.wait() => s.context("extractor exited unexpectedly")?,
        _ = abort.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("extract cancelled");
        }
    };
    if !status.success() {
        bail!("extractor exited with status {status}");
    }
    Ok(())
}

/// Resolve where `uv` lives. Probes (in order):
///   1. `<sidecar_dir>/uv(.exe)` — Tauri externalBin layout
///   2. `<resource_dir>/uv(.exe)` + `<resource_dir>/binaries/uv(.exe)`
///   3. `uv` on $PATH
///   4. `~/.local/bin/uv(.exe)` — typical pipx / installer location
pub fn resolve_uv_path(resource_dir: Option<&Path>) -> PathBuf {
    let exe = paths::bundled_uv_binary_name();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(self_exe) = std::env::current_exe() {
        if let Some(parent) = self_exe.parent() {
            candidates.push(parent.join(exe));
        }
    }
    if let Some(r) = resource_dir {
        candidates.push(r.join(exe));
        candidates.push(r.join("binaries").join(exe));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".local").join("bin").join(exe));
    }

    for c in &candidates {
        if c.exists() {
            return c.clone();
        }
    }
    // Last resort — let the OS resolve via PATH at spawn time.
    PathBuf::from(exe)
}
