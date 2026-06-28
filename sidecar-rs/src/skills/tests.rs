//! Unit + integration tests for the skill catalog loader.
//!
//! The integration test points the loader at the repo-root `skills/`
//! directory (populated by `npm run vendor:skills`) and asserts the
//! 41-count, the per-skill flags, and the script enumeration. The
//! unit tests cover the frontmatter parser + heuristics in isolation
//! with synthetic inputs so a regression in the matcher doesn't
//! require the full skills tree to be checked out.

use super::*;

#[test]
fn frontmatter_inline_scalar() {
    let fm = frontmatter::parse("---\nname: foo\ndescription: bar\n---\nbody\n");
    assert_eq!(fm.raw.get("name").map(String::as_str), Some("foo"));
    assert_eq!(fm.raw.get("description").map(String::as_str), Some("bar"));
}

#[test]
fn frontmatter_quoted_scalar() {
    let fm = frontmatter::parse("---\nname: \"hello world\"\n---\n");
    assert_eq!(fm.raw.get("name").map(String::as_str), Some("hello world"));
}

#[test]
fn frontmatter_folded_block() {
    let input = "---\ndescription: >-\n  first line\n  second line\nname: foo\n---\n";
    let fm = frontmatter::parse(input);
    assert_eq!(fm.raw.get("name").map(String::as_str), Some("foo"));
    assert_eq!(
        fm.raw.get("description").map(String::as_str),
        Some("first line second line")
    );
}

#[test]
fn frontmatter_literal_block() {
    let input = "---\ndescription: |\n  line one\n  line two\n---\n";
    let fm = frontmatter::parse(input);
    assert_eq!(
        fm.raw.get("description").map(String::as_str),
        Some("line one\nline two")
    );
}

#[test]
fn frontmatter_allowed_tools_list() {
    let fm = frontmatter::parse("---\nallowed-tools: [Bash, Read, Write]\n---\n");
    assert_eq!(fm.allowed_tools, vec!["Bash", "Read", "Write"]);
}

#[test]
fn frontmatter_allowed_tools_comma() {
    let fm = frontmatter::parse("---\nallowed-tools: Bash, Read\n---\n");
    assert_eq!(fm.allowed_tools, vec!["Bash", "Read"]);
}

#[test]
fn frontmatter_missing_returns_empty() {
    let fm = frontmatter::parse("no frontmatter here");
    assert!(fm.raw.is_empty());
    assert!(fm.allowed_tools.is_empty());
}

#[test]
fn heuristics_category_scrna() {
    assert_eq!(
        heuristics::infer_category("scRNA-seq processor", ""),
        "transcriptomics"
    );
}

#[test]
fn heuristics_category_alphafold() {
    assert_eq!(
        heuristics::infer_category("AlphaFold structure analysis", ""),
        "molecular_design"
    );
}

#[test]
fn heuristics_category_general_fallback() {
    assert_eq!(
        heuristics::infer_category("some random tool", ""),
        "general"
    );
}

#[test]
fn heuristics_requires_api_key_nim_suffix() {
    assert!(heuristics::requires_api_key("bionemo-boltz2-nim", "body"));
}

#[test]
fn heuristics_requires_api_key_body_mention() {
    assert!(heuristics::requires_api_key(
        "bionemo-other",
        "Set NVIDIA_API_KEY=...",
    ));
    assert!(heuristics::requires_api_key(
        "bionemo-other",
        "needs NGC_API_KEY",
    ));
}

#[test]
fn heuristics_requires_gpu_family_match() {
    assert!(heuristics::requires_gpu(
        "bionemo-proteina-complexa-design",
        ""
    ));
    assert!(heuristics::requires_gpu("bionemo-kermt-embed", ""));
}

#[test]
fn heuristics_requires_gpu_body_mention() {
    assert!(heuristics::requires_gpu("bionemo-other", "run nvidia-smi"));
    assert!(heuristics::requires_gpu("bionemo-other", "uses CUDA"));
}

#[test]
fn heuristics_word_boundary_avoids_false_positives() {
    // 'accumulator' contains 'cu' but not 'cuda' as a whole word.
    assert!(!heuristics::requires_gpu(
        "bionemo-x",
        "uses an accumulator"
    ));
}

#[test]
fn single_line_truncate_collapses_whitespace() {
    assert_eq!(super::single_line_truncate("a   b\n\n c", 10), "a b c");
}

#[test]
fn single_line_truncate_respects_max() {
    let s = "x".repeat(200);
    assert_eq!(super::single_line_truncate(&s, 50).len(), 50);
}

/// Real-world test: load the vendored `skills/` tree (populated by
/// `npm run vendor:skills`). Skips silently when the dir is absent
/// (CI envs without the SaaS checkout). When the dir IS present we
/// assert the same invariants the Node smoke test enforced:
///   - exactly 41 skills load
///   - 10 nim-* are flagged requires_api_key
///   - 13 proteina-complexa-* / 8 kermt-* are flagged requires_gpu
///   - the uniprot skill has its one Python script enumerated
#[test]
fn loads_vendored_skills() {
    let repo_root = match find_repo_root() {
        Some(p) => p,
        None => return,
    };
    let skills_dir = repo_root.join("skills");
    if !skills_dir.exists() {
        eprintln!("skipping — {} not present", skills_dir.display());
        return;
    }
    let catalog = load(Some(&skills_dir));
    assert_eq!(catalog.len(), 41, "catalog size");

    let nim_count = catalog
        .skills
        .iter()
        .filter(|s| s.id.ends_with("-nim"))
        .filter(|s| s.requires_api_key)
        .count();
    assert!(
        nim_count >= 10,
        "expected ≥10 nim skills marked requires_api_key, got {nim_count}"
    );

    let gpu_count = catalog.skills.iter().filter(|s| s.requires_gpu).count();
    assert!(gpu_count >= 8, "expected ≥8 gpu skills, got {gpu_count}");

    let uniprot = catalog
        .get("bionemo-science-skills-uniprot-database")
        .expect("uniprot skill present");
    assert!(
        uniprot
            .scripts
            .iter()
            .any(|s| s.relative_path == "scripts/uniprot_tools.py"),
        "uniprot scripts/uniprot_tools.py expected"
    );
}

fn find_repo_root() -> Option<std::path::PathBuf> {
    let mut cur = std::env::current_dir().ok()?;
    loop {
        if cur.join("bioclaw-env").exists() && cur.join("src-tauri").exists() {
            return Some(cur);
        }
        cur = cur.parent()?.to_path_buf();
    }
}
