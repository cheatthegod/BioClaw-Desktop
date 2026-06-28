//! `invoke_skill(skill_id)` tool — returns the SKILL.md body.
//!
//! Mirrors `sidecar/src/skills/runner.ts::runSkillTool` line-for-line:
//!   * Reject empty / unknown skill_id with a deterministic error.
//!   * Clamp the body to MAX_BODY_CHARS, breaking at a paragraph
//!     boundary when possible so we don't cut mid-fence.
//!   * Prefix with a short header (name, category, capability flags)
//!     and append the "this only LOADS the playbook" hint.

use serde_json::json;

use super::{ToolHandlerContext, ToolHandlerResult};

const MAX_BODY_CHARS: usize = 24_000;

const HINT: &str = "\n\n---\n_(BioClaw Desktop sidecar: invoke_skill only LOADS the playbook. To actually run a script the skill ships with, call `run_skill_script(skill_id, script, args)` — that path is gated by user permission and returns real stdout/stderr.)_";

pub fn schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "skill_id": {
                "type": "string",
                "description": "The id of the skill to invoke (e.g. \"bionemo-nvmolkit\"). Pick from the list of available skills in the system prompt."
            },
            "args": {
                "type": "object",
                "description": "Optional structured arguments. Currently ignored — the SKILL.md body is returned regardless — but the field exists so the LLM can pass intent without errors.",
                "additionalProperties": true
            }
        },
        "required": ["skill_id"],
        "additionalProperties": false
    })
}

pub const NAME: &str = "invoke_skill";
pub const DESCRIPTION: &str = "Load and consult a BioClaw skill (BioNeMo workflow / database query / scientific pipeline). Returns the full SKILL.md content so you can follow its instructions. After reading the playbook, use `run_skill_script` to actually execute any Python or shell scripts the skill ships with.";

pub async fn handle(ctx: &ToolHandlerContext, args: &serde_json::Value) -> ToolHandlerResult {
    let skill_id = args
        .get("skill_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if skill_id.is_empty() {
        return ToolHandlerResult::err(
            "invoke_skill: missing required argument `skill_id` (string).",
        );
    }
    let Some(skill) = ctx.state.skills.get(skill_id) else {
        return ToolHandlerResult::err(format!(
            "invoke_skill: no skill with id \"{skill_id}\" is installed in this BioClaw Desktop build. Pick one from the system-prompt list."
        ));
    };

    let (body, truncated) = clamp_body(&skill.body);
    let mut header_lines: Vec<String> = vec![
        format!("# Skill: {} ({})", skill.name, skill.id),
        format!("Category: {}", skill.category),
    ];
    if skill.requires_api_key {
        header_lines.push("Requires NVIDIA NGC / NVAIE API key.".into());
    }
    if skill.requires_gpu {
        header_lines.push("Requires a local NVIDIA GPU.".into());
    }
    if !skill.allowed_tools.is_empty() {
        header_lines.push(format!(
            "Skill-side allowed-tools: {}",
            skill.allowed_tools.join(", ")
        ));
    }
    header_lines.push(String::new());
    header_lines.push(
        "Full SKILL.md content follows. Read it carefully and surface relevant steps to the user."
            .into(),
    );
    header_lines.push(String::new());
    let header = header_lines.join("\n");

    let mut out = format!("{header}\n{body}");
    if truncated {
        out.push_str(
            "\n\n_(SKILL.md truncated to fit context window. Ask the user if they want to see the rest.)_",
        );
    }
    out.push_str(HINT);
    ToolHandlerResult::ok(out)
}

fn clamp_body(body: &str) -> (String, bool) {
    if body.len() <= MAX_BODY_CHARS {
        return (body.to_string(), false);
    }
    // char-boundary safe truncation at MAX_BODY_CHARS, then prefer a
    // `\n\n` break in the back-third of the slice.
    let mut hard = MAX_BODY_CHARS;
    while hard > 0 && !body.is_char_boundary(hard) {
        hard -= 1;
    }
    let slice = &body[..hard];
    let cut = match slice.rfind("\n\n") {
        Some(i) if i > MAX_BODY_CHARS * 7 / 10 => i,
        _ => hard,
    };
    (body[..cut].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_under_limit_is_passthrough() {
        let s = "hello world";
        let (out, trunc) = clamp_body(s);
        assert_eq!(out, s);
        assert!(!trunc);
    }

    #[test]
    fn clamp_over_limit_breaks_at_paragraph() {
        let mut s = String::new();
        for _ in 0..3000 {
            s.push_str("aaaaaaaa\n");
        }
        s.push_str("\n\n");
        // tail beyond MAX so we know we truncated
        for _ in 0..3000 {
            s.push_str("bbbbbbbb\n");
        }
        let (out, trunc) = clamp_body(&s);
        assert!(trunc);
        assert!(out.len() <= MAX_BODY_CHARS);
    }
}
