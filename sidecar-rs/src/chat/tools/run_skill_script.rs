//! `run_skill_script(skill_id, script, args?, timeout_ms?)` tool.
//!
//! Mirrors `sidecar/src/skills/scriptRunner.ts`:
//!   1. Validate skill_id + script against the catalog's whitelist.
//!   2. Defense-in-depth path check: the resolved script must stay
//!      inside the skill's `absolute_dir` (no `..` traversal).
//!   3. Pick interpreter (python venv → python3 fallback for .py,
//!      bash for .sh / .bash).
//!   4. Permission gate: skip if `(skill_id, script)` is in the
//!      allow-always cache; otherwise register a pending request,
//!      emit a `permission-needed` SSE event, await the decision.
//!   5. Spawn with a minimal env (PATH/HOME/LANG/TMPDIR only — no
//!      OpenRouter keys can leak into a runaway script), capture
//!      stdout/stderr (truncated to 64 KB each), enforce a timeout.
//!   6. Format the result as Markdown for the LLM.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tracing::{debug, warn};

use super::{ToolHandlerContext, ToolHandlerResult};
use crate::chat::types::AgentEvent;
use crate::permissions::{PermissionDecision, PermissionKey};
use crate::skills::ScriptKind;

const STDOUT_LIMIT: usize = 64 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MIN_TIMEOUT_MS: u64 = 1_000;

pub const NAME: &str = "run_skill_script";
pub const DESCRIPTION: &str = "Execute a Python or shell script that ships with a BioClaw skill. Use this AFTER reading SKILL.md (via invoke_skill) to actually run one of the scripts the skill documents. Returns stdout, stderr, exit_code, and timing. The user must have granted execution permission — if not, the call returns a permission-denied result and you should ask the user to enable it in Settings → Permissions.";

pub fn schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "skill_id": {
                "type": "string",
                "description": "The id of the skill whose script to run (e.g. \"bionemo-science-skills-uniprot-database\")."
            },
            "script": {
                "type": "string",
                "description": "Relative path of the script inside the skill dir (e.g. \"scripts/uniprot_tools.py\"). Must be one of the scripts the skill ships with."
            },
            "args": {
                "type": "array",
                "description": "Command-line arguments passed to the script after the interpreter. Always pass as an array, NOT a single shell string.",
                "items": { "type": "string" }
            },
            "timeout_ms": {
                "type": "number",
                "description": "Optional timeout in milliseconds. Defaults to 30000, capped at 300000."
            }
        },
        "required": ["skill_id", "script"],
        "additionalProperties": false
    })
}

pub async fn handle(ctx: &ToolHandlerContext, args: &serde_json::Value) -> ToolHandlerResult {
    let skill_id = args.get("skill_id").and_then(|v| v.as_str()).unwrap_or("");
    let script_arg = args.get("script").and_then(|v| v.as_str()).unwrap_or("");
    let argv: Vec<String> = args
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let timeout_raw = args
        .get("timeout_ms")
        .and_then(|v| v.as_f64())
        .map(|n| n as u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let timeout_ms = timeout_raw.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

    if skill_id.is_empty() {
        return ToolHandlerResult::err("run_skill_script: missing required argument `skill_id`.");
    }
    if script_arg.is_empty() {
        return ToolHandlerResult::err("run_skill_script: missing required argument `script`.");
    }
    let Some(skill) = ctx.state.skills.get(skill_id) else {
        return ToolHandlerResult::err(format!(
            "run_skill_script: no skill with id \"{skill_id}\" is installed."
        ));
    };

    // Validate script against the whitelist + defense-in-depth path check.
    let normalized = script_arg.replace('\\', "/");
    let Some(script_meta) = skill.scripts.iter().find(|s| s.relative_path == normalized) else {
        let sample: String = skill
            .scripts
            .iter()
            .take(8)
            .map(|s| s.relative_path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return ToolHandlerResult::err(format!(
            "run_skill_script: script \"{script_arg}\" is not in this skill's allow-list. Available: {}",
            if sample.is_empty() { "(none)" } else { &sample }
        ));
    };
    let abs_dir: &Path = &skill.absolute_dir;
    let candidate = abs_dir.join(&script_meta.relative_path);
    if !candidate.starts_with(abs_dir) {
        return ToolHandlerResult::err(format!(
            "run_skill_script: script \"{script_arg}\" resolves outside its skill directory (refusing)"
        ));
    }

    let interpreter = pick_interpreter(script_meta.kind, &ctx.state.project_dir);

    // ── permission gate ─────────────────────────────────────────────
    let key = PermissionKey::new(skill_id, script_arg);
    let decision = if ctx.permissions().is_allow_always(&key) {
        PermissionDecision::Allow
    } else {
        request_permission(ctx, skill_id, script_arg, &interpreter, &argv).await
    };

    if matches!(decision, PermissionDecision::Deny) {
        return ToolHandlerResult::err(format!(
            "run_skill_script: execution denied. The user has not granted permission to run scripts from this skill. \
             Tell the user: \"I can run `{script_arg}` from `{skill_id}` for you, but you'll need to allow script execution in Settings → Permissions first.\""
        ));
    }
    // Persist the always-allow after a fresh "Allow" so the next call skips the modal.
    if matches!(decision, PermissionDecision::Allow) && !ctx.permissions().is_allow_always(&key) {
        if let Err(e) = ctx.permissions().remember(key) {
            warn!("could not persist allow-always decision: {e:#}");
        }
    }

    // ── spawn ───────────────────────────────────────────────────────
    let start = Instant::now();
    let mut cmd = Command::new(&interpreter);
    cmd.arg(&candidate)
        .args(&argv)
        .current_dir(abs_dir)
        .env_clear()
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    debug!(skill_id, script = script_arg, interpreter = %interpreter, "spawning skill script");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ToolHandlerResult::err(format_failed_spawn(
                skill_id,
                script_arg,
                &interpreter,
                &e,
            ));
        }
    };

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let stdout_pipe = child.stdout.take().expect("stdout piped");
    let stderr_pipe = child.stderr.take().expect("stderr piped");
    let stdout_task = tokio::spawn(read_capped(stdout_pipe, STDOUT_LIMIT));
    let stderr_task = tokio::spawn(read_capped(stderr_pipe, STDERR_LIMIT));

    let mut timed_out = false;
    let mut aborted = false;
    let exit_status = tokio::select! {
        s = child.wait() => s,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            timed_out = true;
            let _ = child.start_kill();
            child.wait().await
        }
        _ = ctx.abort.cancelled() => {
            aborted = true;
            let _ = child.start_kill();
            child.wait().await
        }
    };

    if let Ok((s, t)) = stdout_task.await {
        stdout_buf = s;
        stdout_truncated = t;
    }
    if let Ok((s, t)) = stderr_task.await {
        stderr_buf = s;
        stderr_truncated = t;
    }
    if aborted {
        stderr_buf.push_str("\n[sidecar: child was aborted by client]");
    } else if timed_out {
        stderr_buf.push_str(&format!("\n[sidecar: timeout after {timeout_ms}ms]"));
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let (exit_code, signal) = match exit_status {
        Ok(s) => exit_status_split(s),
        Err(e) => {
            stderr_buf.push_str(&format!("\n[sidecar: wait failed: {e}]"));
            (None, None)
        }
    };

    let summary = format_result(FormatArgs {
        skill_id,
        script: script_arg,
        interpreter: &interpreter,
        argv: &argv,
        exit_code,
        signal: signal.as_deref(),
        stdout: &stdout_buf,
        stderr: &stderr_buf,
        stdout_truncated,
        stderr_truncated,
        timed_out,
        duration_ms,
        decision,
    });
    ToolHandlerResult {
        output: summary,
        is_error: exit_code != Some(0) || timed_out,
    }
}

fn pick_interpreter(kind: ScriptKind, project_dir: &Path) -> String {
    match kind {
        ScriptKind::Python => {
            // Prefer the bundled venv python (set up by L.3) when ready,
            // otherwise fall back to python3 on PATH.
            let py = crate::env::state::preferred_interpreter(project_dir);
            py.map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "python3".into())
        }
        ScriptKind::Shell => "bash".into(),
    }
}

async fn request_permission(
    ctx: &ToolHandlerContext,
    skill_id: &str,
    script: &str,
    interpreter: &str,
    argv: &[String],
) -> PermissionDecision {
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = ctx.permissions().register_pending(request_id.clone());

    // Emit permission-needed event. If the SSE stream is closed
    // (client disconnect), the send errs — we treat that as Deny.
    if ctx
        .events
        .send(AgentEvent::PermissionNeeded {
            request_id: request_id.clone(),
            skill_id: skill_id.to_string(),
            script: script.to_string(),
            interpreter: interpreter.to_string(),
            args: argv.to_vec(),
        })
        .await
        .is_err()
    {
        // Clean up the pending entry so a late /permissions/decide
        // doesn't leak.
        ctx.permissions()
            .resolve_pending(&request_id, PermissionDecision::Deny);
        return PermissionDecision::Deny;
    }

    // Wait for the user's decision OR a client abort.
    tokio::select! {
        decision = rx => decision.unwrap_or(PermissionDecision::Deny),
        _ = ctx.abort.cancelled() => {
            ctx.permissions().resolve_pending(&request_id, PermissionDecision::Deny);
            PermissionDecision::Deny
        }
    }
}

/// Read up to `limit` bytes from `pipe` into a String. Excess bytes are
/// drained and dropped; second return value is `true` if any bytes
/// past the limit were observed.
async fn read_capped(
    mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    limit: usize,
) -> (String, bool) {
    let mut buf = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0u8; 4096];
    let mut truncated = false;
    loop {
        let n = match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if buf.len() >= limit {
            truncated = true;
            continue;
        }
        let room = limit - buf.len();
        if n > room {
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
        } else {
            buf.extend_from_slice(&chunk[..n]);
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

fn exit_status_split(s: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
    if let Some(code) = s.code() {
        (Some(code), None)
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let sig = s.signal().map(|n| signal_name(n).to_string());
            (None, sig)
        }
        #[cfg(not(unix))]
        {
            (None, None)
        }
    }
}

#[cfg(unix)]
fn signal_name(n: i32) -> &'static str {
    match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        9 => "SIGKILL",
        15 => "SIGTERM",
        _ => "SIG?",
    }
}

fn format_failed_spawn(
    skill_id: &str,
    script: &str,
    interpreter: &str,
    err: &std::io::Error,
) -> String {
    format!(
        "# run_skill_script result\n\
         Skill: `{skill_id}`\n\
         Command: `{interpreter} {script}`\n\
         Status: **failed to spawn** ({err})\n\
         The interpreter could not be launched; this is usually because it isn't installed yet or isn't on PATH.\n"
    )
}

struct FormatArgs<'a> {
    skill_id: &'a str,
    script: &'a str,
    interpreter: &'a str,
    argv: &'a [String],
    exit_code: Option<i32>,
    signal: Option<&'a str>,
    stdout: &'a str,
    stderr: &'a str,
    stdout_truncated: bool,
    stderr_truncated: bool,
    timed_out: bool,
    duration_ms: u64,
    decision: PermissionDecision,
}

fn format_result(a: FormatArgs<'_>) -> String {
    let status = if a.timed_out {
        format!("TIMED OUT after {}ms", a.duration_ms)
    } else if let Some(sig) = a.signal {
        format!("terminated by {sig}")
    } else if let Some(code) = a.exit_code {
        format!("exited {code}")
    } else {
        "unknown".into()
    };
    let argv_quoted = if a.argv.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = a
            .argv
            .iter()
            .map(|s| serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")))
            .collect();
        format!(" {}", parts.join(" "))
    };
    let cmd_line = format!("{} {}{}", a.interpreter, a.script, argv_quoted);

    let mut lines: Vec<String> = Vec::with_capacity(20);
    lines.push("# run_skill_script result".into());
    lines.push(format!("Skill: `{}`", a.skill_id));
    lines.push(format!("Command: `{cmd_line}`"));
    lines.push(format!("Status: **{status}** ({}ms)", a.duration_ms));
    if matches!(a.decision, PermissionDecision::AllowOnce) {
        lines.push("Permission: allowed for this turn only.".into());
    }
    lines.push(String::new());
    lines.push("## stdout".into());
    lines.push("```".into());
    lines.push(a.stdout.to_string());
    lines.push("```".into());
    if a.stdout_truncated {
        lines.push("_(stdout truncated to 64 KB)_".into());
    }
    lines.push(String::new());
    lines.push("## stderr".into());
    lines.push("```".into());
    lines.push(a.stderr.to_string());
    lines.push("```".into());
    if a.stderr_truncated {
        lines.push("_(stderr truncated to 64 KB)_".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_clamp_floor() {
        let v: u64 = 100;
        let clamped = v.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        assert_eq!(clamped, MIN_TIMEOUT_MS);
    }

    #[test]
    fn timeout_clamp_ceiling() {
        let v: u64 = 10_000_000;
        let clamped = v.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        assert_eq!(clamped, MAX_TIMEOUT_MS);
    }

    #[test]
    fn pick_interpreter_python_with_no_venv_falls_back_to_python3() {
        let interp = pick_interpreter(ScriptKind::Python, Path::new("/nonexistent"));
        assert_eq!(interp, "python3");
    }

    #[test]
    fn pick_interpreter_shell_is_bash() {
        let interp = pick_interpreter(ScriptKind::Shell, Path::new("/nonexistent"));
        assert_eq!(interp, "bash");
    }
}
