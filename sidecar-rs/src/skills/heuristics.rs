//! Category inference + requires-{api-key, gpu} detection.
//!
//! Verbatim port of the JS heuristics in
//! `sidecar/src/skills/loader.ts::inferCategory / detectRequiresApiKey
//! / detectRequiresGpu`. Same buckets, same tokens, same regexes —
//! kept here so a future refactor in the SaaS catalog can be cross-
//! checked byte-for-byte.

pub fn infer_category(name: &str, description: &str) -> String {
    let haystack = format!("{name} {description}").to_lowercase();
    let h = haystack.as_str();
    if contains_any(
        h,
        &[
            "scrna",
            "single-cell",
            "single cell",
            "seurat",
            "cell-type",
            "cell type",
            "annotation",
            "cellchat",
        ],
    ) {
        return "transcriptomics".into();
    }
    if contains_any(
        h,
        &[
            "rna-seq",
            "rna seq",
            "rnaseq",
            "bulk-expression",
            "bulk expression",
            "deseq",
            "edger",
            "salmon",
            "kallisto",
        ],
    ) {
        return "transcriptomics".into();
    }
    if contains_any(
        h,
        &[
            "chip-seq",
            "chip seq",
            "chipseq",
            "atac-seq",
            "atac seq",
            "atacseq",
            "methylation",
            "histone",
            "chromatin",
            "enhancer",
        ],
    ) {
        return "epigenomics".into();
    }
    if contains_any(
        h,
        &[
            "proteomic",
            "mass-spec",
            "mass spec",
            "metabolom",
            "lipidom",
        ],
    ) {
        return "proteomics_metabolomics".into();
    }
    if contains_any(
        h,
        &["pubmed", "literature", "paper", "abstract", "citation"],
    ) {
        return "literature".into();
    }
    if contains_any(
        h,
        &[
            "alphafold",
            "protein-struct",
            "protein struct",
            "pdb",
            "docking",
            "rfdiffusion",
            "esm",
        ],
    ) {
        return "molecular_design".into();
    }
    if contains_any(
        h,
        &[
            "clinicaltrial",
            "drug-repurpos",
            "drug repurpos",
            "cmap",
            "lincs",
            "target-disease",
            "target disease",
        ],
    ) {
        return "drug_discovery".into();
    }
    if contains_any(h, &["variant", "gwas", "mutation", "cnv", "vcf", "maf"]) {
        return "genomics_genetics".into();
    }
    if contains_any(
        h,
        &[
            "pathway", "enrich", "gsea", "go-term", "go term", "kegg", "reactome",
        ],
    ) {
        return "pathway_analysis".into();
    }
    if contains_any(
        h,
        &[
            "manuscript",
            "report",
            "figure",
            "slide",
            "ppt",
            "pptx",
            "pdf",
        ],
    ) {
        return "reporting".into();
    }
    if h.contains("integrat") {
        return "integration".into();
    }
    if contains_any(h, &["multi-omics", "multi omics", "multiomics"]) {
        return "multi_omics".into();
    }
    "general".into()
}

pub fn requires_api_key(dir_name: &str, body: &str) -> bool {
    if dir_name.ends_with("-nim") {
        return true;
    }
    body.contains("NVIDIA_API_KEY") || body.contains("NGC_API_KEY")
}

pub fn requires_gpu(dir_name: &str, body: &str) -> bool {
    if dir_name.contains("proteina-complexa") || dir_name.contains("kermt") {
        return true;
    }
    let lower = body.to_lowercase();
    word_contains(&lower, "nvidia-smi") || word_contains(&lower, "cuda")
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// Cheap word-boundary check — char before/after the match must NOT be
/// `[a-z0-9_-]`. Matches the JS `\bnvidia-smi\b` semantics closely
/// enough for our corpus; we don't need a full regex engine for this.
fn word_contains(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let nlen = needle.len();
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(needle) {
        let abs = start + rel;
        let before_ok = abs == 0 || !is_word_char(bytes[abs - 1]);
        let after_ok = abs + nlen == bytes.len() || !is_word_char(bytes[abs + nlen]);
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}
