//! Skill-ranked system-prompt addendum.
//!
//! Mirrors `sidecar/src/skills/registry.ts::composeSkillsSystemPrompt`:
//! tokenize the last user turn, rank skills by overlap with each
//! skill's `name + id + full_description`, take the top K, and emit
//! a bullet-list addendum the chat handler concatenates with the
//! user-supplied system prompt.

use std::collections::HashSet;

use crate::skills::{DesktopSkill, SkillCatalog};

const TOP_K: usize = 6;

const STOP_TOKENS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "how", "i", "if", "in",
    "is", "it", "me", "my", "of", "on", "or", "so", "the", "to", "use", "using", "with", "you",
    "your", "this", "that",
];

pub fn compose(catalog: &SkillCatalog, last_user_text: &str) -> String {
    if catalog.is_empty() {
        return String::new();
    }
    let chosen = rank(catalog, last_user_text, TOP_K);
    let chosen: Vec<&DesktopSkill> = if chosen.is_empty() {
        catalog.skills.iter().take(TOP_K).collect()
    } else {
        chosen
    };
    if chosen.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = vec![
        "## Available BioClaw skills".into(),
        "You have two skill tools:".into(),
        "  1. `invoke_skill(skill_id)` — load the skill's SKILL.md playbook so you can read its instructions.".into(),
        "  2. `run_skill_script(skill_id, script, args)` — actually execute a Python or shell script the skill ships with. The user must have enabled script execution; if not, the tool returns a permission-denied result and you should tell the user to enable it in Settings → Permissions.".into(),
        String::new(),
        "Standard flow: call `invoke_skill` first to read the playbook, then call `run_skill_script` for whichever step the user wants. For skills that flag `needs NVIDIA API key` or `needs GPU`, prefer reading-the-playbook + walking the user through it rather than calling run_skill_script — the local machine may not have the credentials/hardware.".into(),
        String::new(),
        "Skills (top match first):".into(),
    ];

    for s in chosen {
        let mut flags: Vec<String> = Vec::new();
        if s.requires_api_key {
            flags.push("needs NVIDIA API key".into());
        }
        if s.requires_gpu {
            flags.push("needs GPU".into());
        }
        if !s.scripts.is_empty() {
            flags.push(format!("{} script(s)", s.scripts.len()));
        }
        let flags_str = if flags.is_empty() {
            String::new()
        } else {
            format!(" _({})_", flags.join(", "))
        };
        lines.push(format!("- `{}`: {}{flags_str}", s.id, s.description));
        if !s.scripts.is_empty() && s.scripts.len() <= 4 {
            let names: Vec<String> = s
                .scripts
                .iter()
                .map(|sc| format!("`{}`", sc.relative_path))
                .collect();
            lines.push(format!("    scripts: {}", names.join(", ")));
        }
    }
    lines.join("\n")
}

fn rank<'a>(catalog: &'a SkillCatalog, text: &str, limit: usize) -> Vec<&'a DesktopSkill> {
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return Vec::new();
    }
    let token_set: HashSet<&str> = tokens.iter().map(String::as_str).collect();
    let mut scored: Vec<(&DesktopSkill, usize)> = Vec::new();
    for s in catalog.skills.iter() {
        let hay = tokenize(&format!("{} {} {}", s.name, s.id, s.full_description));
        let score = hay
            .iter()
            .filter(|t| token_set.contains(t.as_str()))
            .count();
        if score > 0 {
            scored.push((s, score));
        }
    }
    scored.sort_by(|(a_s, a_score), (b_s, b_score)| {
        b_score.cmp(a_score).then_with(|| a_s.id.cmp(&b_s.id))
    });
    scored.into_iter().take(limit).map(|(s, _)| s).collect()
}

fn tokenize(text: &str) -> Vec<String> {
    let stops: HashSet<&str> = STOP_TOKENS.iter().copied().collect();
    text.to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter(|t| t.len() >= 3 && !stops.contains(*t))
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_filters_stops_and_shorts() {
        let toks = tokenize("How do I align this with AlphaFold?");
        // "how/do/i/this/with" are stops, "align/alphafold" remain;
        // single-char drops below length threshold too.
        assert!(toks.contains(&"align".to_string()));
        assert!(toks.contains(&"alphafold".to_string()));
        assert!(!toks.contains(&"how".to_string()));
        assert!(!toks.contains(&"with".to_string()));
    }

    #[test]
    fn empty_query_yields_empty_addendum_with_empty_catalog() {
        let catalog = SkillCatalog::default();
        assert!(compose(&catalog, "anything").is_empty());
    }
}
