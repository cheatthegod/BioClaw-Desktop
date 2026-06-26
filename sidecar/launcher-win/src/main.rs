//! BioClaw sidecar Windows launcher.
//!
//! Why this exists: our sidecar is an esbuild-bundled Node.js script
//! (~99 KB). On macOS/Linux a `#!/usr/bin/env node` shebang on a +x file
//! is enough — the kernel resolves it and runs `node /path/to/sidecar`.
//! Windows has no shebang, so an `*.exe` that's actually a JS bundle
//! simply fails to spawn. This launcher.exe is the smallest possible
//! native bridge: locate `node.exe`, then `CreateProcess` it with the
//! adjacent JS bundle.
//!
//! Naming convention (Tauri externalBin): the launcher MUST be named
//! `bioclaw-sidecar-x86_64-pc-windows-msvc.exe` to satisfy Tauri's per-
//! triple suffix expectation. The JS bundle living next to it is
//! `bioclaw-sidecar-x86_64-pc-windows-msvc.js`.
//!
//! Behaviour:
//! 1. Locate node.exe (PATH first; well-known install paths next).
//! 2. Resolve the JS bundle path: same directory as the launcher, same
//!    stem with `.js` extension.
//! 3. Spawn node.exe with the bundle as argv[1] and any args we got
//!    appended. Inherit stdin/stdout/stderr so Tauri's port-discovery
//!    (PORT=NNNN line on stdout) and the STDIN-EOF shutdown signal work
//!    transparently.
//! 4. Wait for the child, propagate exit code.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let argv: Vec<String> = env::args().collect();
    let launcher_path = match env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bioclaw-sidecar-launcher: current_exe failed: {e}");
            return ExitCode::from(2);
        }
    };

    let bundle_path = resolve_bundle_path(&launcher_path);
    if !bundle_path.is_file() {
        eprintln!(
            "bioclaw-sidecar-launcher: cannot find sidecar JS bundle at {}",
            bundle_path.display()
        );
        return ExitCode::from(3);
    }

    let node = match find_node() {
        Some(p) => p,
        None => {
            eprintln!(
                "bioclaw-sidecar-launcher: node.exe not found on PATH or in standard install \
                 locations. Install Node.js 20+ from https://nodejs.org/ and ensure it's on PATH.",
            );
            return ExitCode::from(4);
        }
    };

    let extra_args = argv.iter().skip(1).cloned().collect::<Vec<_>>();
    let mut cmd = Command::new(&node);
    cmd.arg(&bundle_path);
    cmd.args(&extra_args);
    // Inherit stdio — port discovery + stdin EOF signal need this. Setting
    // them explicitly to Stdio::inherit() is the default for `Command`, but
    // we name it for clarity.
    let status = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "bioclaw-sidecar-launcher: failed to spawn `{} {}`: {e}",
                node.display(),
                bundle_path.display()
            );
            return ExitCode::from(5);
        }
    };
    match status.code() {
        Some(c) if c >= 0 && c <= 255 => ExitCode::from(c as u8),
        // Signal-terminated children: cap at 1 to keep ExitCode in range.
        // Windows process status codes are normally u32 so this is mostly
        // a guard for unusual host configurations.
        _ => ExitCode::FAILURE,
    }
}

fn resolve_bundle_path(launcher: &Path) -> PathBuf {
    // Replace ".exe" → ".js" while keeping the rest of the filename intact.
    let parent = launcher.parent().unwrap_or_else(|| Path::new("."));
    let stem = launcher
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bioclaw-sidecar");
    parent.join(format!("{stem}.js"))
}

fn find_node() -> Option<PathBuf> {
    if let Some(p) = which_in_path("node.exe") {
        return Some(p);
    }
    // Well-known install paths. Order: per-user > global > NVM. We keep
    // this list short on purpose — every entry is a place where Windows
    // installers actually drop node.exe by default.
    let candidates: &[&str] = &[
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        r"%LOCALAPPDATA%\Programs\nodejs\node.exe",
        r"%APPDATA%\nvm\current\node.exe",
        r"%USERPROFILE%\scoop\apps\nodejs\current\node.exe",
        r"%USERPROFILE%\scoop\shims\node.exe",
    ];
    for raw in candidates {
        let expanded = expand_env_vars(raw);
        let p = PathBuf::from(expanded);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn which_in_path(binary: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn expand_env_vars(s: &str) -> String {
    // Tiny %VAR% expander — we deliberately avoid pulling in a regex crate
    // here. Anything we don't recognize is passed through verbatim.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut name = String::new();
        let mut closed = false;
        while let Some(&next) = chars.peek() {
            chars.next();
            if next == '%' {
                closed = true;
                break;
            }
            name.push(next);
        }
        if closed {
            if let Ok(val) = env::var(&name) {
                out.push_str(&val);
            } else {
                // Unset var → leave as-is for the caller to notice.
                out.push('%');
                out.push_str(&name);
                out.push('%');
            }
        } else {
            // Trailing unclosed %, very unlikely — preserve.
            out.push('%');
            out.push_str(&name);
        }
    }
    out
}
