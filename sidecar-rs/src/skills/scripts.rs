//! Two-level scan of `<skill>/scripts/` to enumerate runnable scripts.
//!
//! Port of `scanSkillScripts` in the Node loader. Matches the JS
//! depth-2 walk so workflow skills with
//! `<skill>/scripts/<subdir>/foo.py` still get caught. Skips files
//! starting with `_` (Python private helpers — the LLM shouldn't see
//! them as entry points).

use std::path::Path;

use super::{ScriptKind, SkillScript};

pub fn scan(skill_dir: &Path) -> Vec<SkillScript> {
    let scripts_root = skill_dir.join("scripts");
    if !scripts_root.exists() {
        return Vec::new();
    }

    let mut out: Vec<SkillScript> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(scripts_root, 0)];

    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                if depth < 1 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if name.starts_with('_') {
                continue;
            }
            let lower = name.to_lowercase();
            let kind = if lower.ends_with(".py") {
                ScriptKind::Python
            } else if lower.ends_with(".sh") || lower.ends_with(".bash") {
                ScriptKind::Shell
            } else {
                continue;
            };
            // Forward-slash separators in the JSON wire format
            // regardless of host (Windows users see /, not \).
            let rel = path
                .strip_prefix(skill_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(SkillScript {
                relative_path: rel,
                kind,
            });
        }
    }

    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    out
}
