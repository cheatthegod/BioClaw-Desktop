//! Tiny YAML-frontmatter parser. Same shape the Node loader uses —
//! we deliberately don't pull `serde_yaml` because:
//!   1. The skill corpus only uses scalar fields and folded/literal
//!      block strings — `serde_yaml` is overkill for that subset.
//!   2. `serde_yaml` adds ~150 KB to the release binary.
//!   3. We need byte-identical output to the Node loader so the
//!      desktop catalog matches the SaaS catalog on the same input.
//!
//! Supports:
//!   `key: value`            — single-line scalar (with optional
//!                              "..."/'...' quoting)
//!   `key: >` / `key: |`     — folded / literal block continuation,
//!     followed by indented lines until a blank line or a new
//!     top-level key.

use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct SkillFrontmatter {
    pub raw: HashMap<String, String>,
    pub allowed_tools: Vec<String>,
}

/// Parse the leading `---\n...\n---\n` block of a markdown file.
/// Empty / missing frontmatter yields an empty result (not an error).
pub fn parse(raw: &str) -> SkillFrontmatter {
    let Some(inner) = extract_frontmatter_block(raw) else {
        return SkillFrontmatter::default();
    };
    let lines: Vec<&str> = inner.split('\n').collect();

    let mut fm: HashMap<String, String> = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some((key, val)) = parse_top_level(line) else {
            i += 1;
            continue;
        };
        let (final_val, consumed) = if matches!(val.as_str(), ">" | "|" | ">-" | "|-") {
            // Block scalar — fold subsequent indented lines.
            let folded = val.starts_with('>');
            let mut parts: Vec<String> = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                let next = lines[j];
                if next.is_empty() {
                    j += 1;
                    continue;
                }
                // A new top-level key (no leading whitespace + `key:` shape)
                // terminates the block.
                if is_top_level_key(next) {
                    break;
                }
                let trimmed_left = next.trim_start();
                let trimmed = trimmed_left.trim_end();
                parts.push(trimmed.to_string());
                j += 1;
            }
            let joined = if folded {
                parts.join(" ")
            } else {
                parts.join("\n")
            };
            (joined.trim().to_string(), j - i - 1)
        } else if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
            || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
        {
            (val[1..val.len() - 1].to_string(), 0)
        } else {
            (val, 0)
        };
        fm.insert(key, final_val);
        i += 1 + consumed;
    }

    let allowed_tools = parse_allowed_tools(fm.get("allowed-tools").map(String::as_str));
    SkillFrontmatter {
        raw: fm,
        allowed_tools,
    }
}

fn extract_frontmatter_block(raw: &str) -> Option<String> {
    // Strict: must start with `---` on the first line, blank or
    // missing prefix means no frontmatter. Same as the JS regex
    // `^---\s*\n([\s\S]*?)\n---\s*\n?`.
    let bytes = raw.as_bytes();
    if !bytes.starts_with(b"---") {
        return None;
    }
    // Find the end of the opening `---` line.
    let after_open = raw.find('\n')?;
    let body = &raw[after_open + 1..];
    // Find the closing `\n---` (anchored at line start).
    let mut start = 0;
    while let Some(rel) = body[start..].find("\n---") {
        let abs = start + rel;
        // Require the next char after `---` to be whitespace or EOF
        // — avoids matching `---foo` inside the body.
        let after = abs + 4;
        if after >= body.len() {
            return Some(body[..abs].to_string());
        }
        let next = body.as_bytes()[after];
        if next == b'\n' || next == b' ' || next == b'\t' {
            return Some(body[..abs].to_string());
        }
        start = abs + 1;
    }
    None
}

/// Parse a "key: value" line into the components. Returns None for
/// indented lines, comment lines, or anything not matching the shape.
fn parse_top_level(line: &str) -> Option<(String, String)> {
    if line.is_empty() {
        return None;
    }
    let bytes = line.as_bytes();
    // Indented = not a top-level key.
    if bytes[0] == b' ' || bytes[0] == b'\t' {
        return None;
    }
    let mut key_end: Option<usize> = None;
    for (idx, c) in line.char_indices() {
        if idx == 0 {
            // First char must be word-ish: matches `^(\w[\w-]*)`.
            if !(c.is_ascii_alphanumeric() || c == '_') {
                return None;
            }
            continue;
        }
        if c == ':' {
            key_end = Some(idx);
            break;
        }
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return None;
        }
    }
    let key_end = key_end?;
    let key = &line[..key_end];
    let val = line[key_end + 1..].trim().to_string();
    Some((key.to_string(), val))
}

fn is_top_level_key(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    let bytes = line.as_bytes();
    if bytes[0] == b' ' || bytes[0] == b'\t' {
        return false;
    }
    let mut seen_word = false;
    for (i, c) in line.char_indices() {
        if i == 0 {
            if !(c.is_ascii_alphanumeric() || c == '_') {
                return false;
            }
            seen_word = true;
        } else if c == ':' {
            return seen_word;
        } else if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return false;
        }
    }
    false
}

fn parse_allowed_tools(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix('[')
        .unwrap_or(trimmed)
        .strip_suffix(']')
        .unwrap_or_else(|| trimmed.strip_prefix('[').unwrap_or(trimmed));
    stripped
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
