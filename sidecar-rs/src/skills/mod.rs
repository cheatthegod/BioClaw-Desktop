//! Skill catalog — read-only scan of the bundled `skills/` tree.
//!
//! Ported from `sidecar/src/skills/loader.ts`. Same field shape, same
//! heuristics, same caching policy: walk once at process start (or on
//! the first request — whichever comes first), then serve from the
//! Arc-shared snapshot for the lifetime of the process.
//!
//! Data model is identical to the Node loader so the frontend
//! /skills consumer doesn't need to change. The wire format for
//! `GET /skills` lives in `crate::server::routes::skills`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

mod frontmatter;
mod heuristics;
mod scripts;

#[cfg(test)]
mod tests;

/// One skill discovered under the skills root.
///
/// Matches `DesktopSkill` in `sidecar/src/skills/loader.ts` field-for-field
/// so existing /skills consumers (chat-state.ts, SkillsPage, etc.) keep
/// working without protocol changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSkill {
    /// Directory name, slug-form. Matches the SaaS catalog id.
    pub id: String,
    /// Frontmatter `name` field; falls back to `id` when missing.
    pub name: String,
    /// First ~160 chars of `description`, single-line. UI-friendly.
    pub description: String,
    /// Full `description` from frontmatter, untruncated.
    pub full_description: String,
    /// Inferred category — bucket the SaaS uses too.
    pub category: String,
    /// Taxonomy badge — biomni / community / lab.
    pub source: SkillSource,
    /// Full markdown body (frontmatter + content). The LLM reads this.
    pub body: String,
    /// Frontmatter `allowed-tools` list. Empty when unset.
    pub allowed_tools: Vec<String>,
    /// Heuristic: needs NVIDIA NGC / NVAIE API key.
    pub requires_api_key: bool,
    /// Heuristic: needs a local NVIDIA GPU.
    pub requires_gpu: bool,
    /// Absolute path on disk to the skill's root directory (one with
    /// SKILL.md). The script-runner needs this to resolve relative
    /// script paths safely without re-walking the FS per call.
    pub absolute_dir: PathBuf,
    /// Runnable scripts shipped with the skill.
    pub scripts: Vec<SkillScript>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Biomni,
    Community,
    Lab,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScript {
    /// Path relative to the skill dir, forward-slash separators
    /// (Windows-safe in JSON responses).
    pub relative_path: String,
    pub kind: ScriptKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScriptKind {
    Python,
    Shell,
}

/// Owned snapshot of every loaded skill. Cheap to clone (Arc + Vec)
/// so handlers can grab the full list without per-request FS work.
#[derive(Debug, Clone, Default)]
pub struct SkillCatalog {
    pub skills: Arc<Vec<DesktopSkill>>,
    /// Resolved root dir we scanned. None when no skills dir was
    /// configured or it didn't exist.
    pub root: Option<PathBuf>,
}

impl SkillCatalog {
    /// Lookup by id. O(n) — fine for ~50 skills; if the catalog ever
    /// gets large we'll back this with a `HashMap`.
    pub fn get(&self, id: &str) -> Option<&DesktopSkill> {
        self.skills.iter().find(|s| s.id == id)
    }

    /// Number of skills in the catalog.
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// `true` when the catalog is empty (no skills dir, or empty dir).
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
}

/// Walk the skills directory and parse every `bionemo-*/SKILL.md`
/// (and any `bio-*` / `<other>-*` — directory name decides `source`).
/// Errors at the directory level are logged + skipped; the catalog
/// can be partial (matches the Node loader's behaviour, where one
/// broken skill doesn't sink the whole catalog).
pub fn load(skills_dir: Option<&Path>) -> SkillCatalog {
    let Some(root) = skills_dir else {
        warn!("BIOCLAW_SKILLS_DIR unset and no fallback ./skills/; skill catalog is empty");
        return SkillCatalog::default();
    };
    if !root.exists() {
        warn!(path = %root.display(), "skills dir not found");
        return SkillCatalog::default();
    }

    let entries = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(e) => {
            warn!(path = %root.display(), error = %e, "failed to read skills dir");
            return SkillCatalog::default();
        }
    };

    let mut out: Vec<DesktopSkill> = Vec::new();
    let mut seen_dups: HashMap<String, usize> = HashMap::new();
    for entry in entries.flatten() {
        // Accept directories AND symlinks-to-directories — the SaaS
        // sometimes points container/skills/<id> at a data-volume
        // path; desktop uses real copies today but keep the door open.
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_symlink() {
            match path.metadata() {
                Ok(m) if !m.is_dir() => continue,
                Err(_) => continue,
                _ => {}
            }
        }
        let dir_name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        match parse_skill(&path, &dir_name) {
            Some(skill) => {
                *seen_dups.entry(skill.id.clone()).or_insert(0) += 1;
                out.push(skill);
            }
            None => {
                debug!(dir = %path.display(), "skipping entry with no SKILL.md");
            }
        }
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));

    // Surface duplicates loudly so a broken vendor pass doesn't
    // silently surface the same skill twice.
    for (id, count) in seen_dups.iter().filter(|(_, c)| **c > 1) {
        warn!(skill = %id, count, "duplicate skill id in catalog");
    }

    SkillCatalog {
        skills: Arc::new(out),
        root: Some(root.to_path_buf()),
    }
}

fn parse_skill(abs_dir: &Path, dir_name: &str) -> Option<DesktopSkill> {
    let md_path = abs_dir.join("SKILL.md");
    if !md_path.exists() {
        return None;
    }
    let body = std::fs::read_to_string(&md_path).ok()?;

    let fm = frontmatter::parse(&body);
    let name = fm
        .raw
        .get("name")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| dir_name.to_string());
    let full_description = fm.raw.get("description").cloned().unwrap_or_default();
    let description = single_line_truncate(&full_description, 160);
    let raw_category = fm
        .raw
        .get("category")
        .map(|s| s.trim().to_lowercase().replace([' ', '-'], "_"))
        .unwrap_or_default();
    let category = if raw_category.is_empty() {
        heuristics::infer_category(&name, &full_description)
    } else {
        raw_category
    };
    let source = if dir_name.starts_with("bio-") {
        SkillSource::Biomni
    } else {
        SkillSource::Community
    };

    Some(DesktopSkill {
        id: dir_name.to_string(),
        name,
        description,
        full_description,
        category,
        source,
        requires_api_key: heuristics::requires_api_key(dir_name, &body),
        requires_gpu: heuristics::requires_gpu(dir_name, &body),
        absolute_dir: abs_dir.to_path_buf(),
        scripts: scripts::scan(abs_dir),
        allowed_tools: fm.allowed_tools,
        body,
    })
}

/// Collapse whitespace runs to single spaces, trim, truncate to `max`
/// chars — matches the JS `replace(/\s+/g, ' ').slice(0, 160).trim()`.
fn single_line_truncate(s: &str, max: usize) -> String {
    let mut collapsed = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            last_space = true;
        } else {
            collapsed.push(c);
            last_space = false;
        }
    }
    if collapsed.len() > max {
        // Use char_indices to avoid splitting a multi-byte char.
        let cut = collapsed
            .char_indices()
            .take_while(|(i, _)| *i < max)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(max);
        collapsed.truncate(cut);
    }
    collapsed.trim().to_string()
}

/// Resolve the skills dir using BioClaw conventions: `BIOCLAW_SKILLS_DIR`
/// env var wins; else `./skills` if it exists in cwd; else None.
pub fn resolve_skills_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("BIOCLAW_SKILLS_DIR") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    let candidate = std::env::current_dir().ok()?.join("skills");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}
