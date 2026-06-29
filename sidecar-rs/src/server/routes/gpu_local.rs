//! `GET /gpu/local-envs` (goal M3.1).
//!
//! Reports which GPU conda environments are present on THIS machine, so the
//! desktop can offer a "run locally" option when the user's box actually has
//! the env (default stays cloud — most desktops have no GPU). Pure directory
//! scan, no subprocess: the union of
//!   * `$HOME/miniconda3/envs/<name>`
//!   * `${BIOCLAW_GPU_ENVS_DIR:-/lambda/nfs/file2/cqr_files/BioClaw_gpu_envs}/<name>`
//!
//! These are the two locations the SaaS GPU runner's local probe also checks,
//! so a name appearing here means a local run could resolve the env.

use std::collections::BTreeSet;
use std::path::PathBuf;

use axum::Json;
use serde::Serialize;

const DEFAULT_GPU_ENVS_DIR: &str = "/lambda/nfs/file2/cqr_files/BioClaw_gpu_envs";

#[derive(Serialize)]
pub struct LocalEnvsResponse {
    /// Conda env names available locally (sorted, de-duplicated).
    pub envs: Vec<String>,
    /// Whether any local GPU env exists at all (the UI's "local available" gate).
    #[serde(rename = "localAvailable")]
    pub local_available: bool,
}

pub async fn local_envs() -> Json<LocalEnvsResponse> {
    let envs = scan_local_envs();
    Json(LocalEnvsResponse {
        local_available: !envs.is_empty(),
        envs,
    })
}

/// Scan the two env roots and return the sorted union of subdirectory names.
fn scan_local_envs() -> Vec<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("miniconda3").join("envs"));
    }
    let gpu_envs = std::env::var("BIOCLAW_GPU_ENVS_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_GPU_ENVS_DIR.to_string());
    roots.push(PathBuf::from(gpu_envs));

    let mut names: BTreeSet<String> = BTreeSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            // Only directories (conda envs are dirs; ignore the dotfile probe).
            if entry.file_type().map(|t| t.is_dir() || t.is_symlink()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    if !name.starts_with('.') {
                        names.insert(name.to_string());
                    }
                }
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_a_temp_env_dir() {
        let dir = std::env::temp_dir().join(format!("bioclaw-localenv-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("rnagenesis")).unwrap();
        std::fs::create_dir_all(dir.join("foldmark")).unwrap();
        std::fs::write(dir.join(".hidden_probe"), b"").ok();
        std::env::set_var("BIOCLAW_GPU_ENVS_DIR", &dir);
        let envs = scan_local_envs();
        assert!(envs.contains(&"rnagenesis".to_string()), "got {envs:?}");
        assert!(envs.contains(&"foldmark".to_string()));
        assert!(!envs.iter().any(|e| e.starts_with('.')));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
