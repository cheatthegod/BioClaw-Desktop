// Skills loader — read-only scan of the vendored `skills/` tree shipped by
// Tauri as a bundle resource and surfaced to the sidecar through the
// `BIOCLAW_SKILLS_DIR` env var.
//
// Ported from BioClaw-SaaS's `src/community-skills.ts`. We keep the YAML
// frontmatter parser intentionally tiny (no `yaml` dep) — the corpus uses
// only scalar fields plus folded/literal block strings, which is exactly
// what the SaaS parser already handles. Forking is fine here: the upstream
// parser also imports a server-side logger we don't want in the sidecar
// bundle, and the desktop variant needs a couple of extra signals
// (`requiresApiKey`, `requiresGpu`) that the SaaS UI doesn't care about.
//
// Cache: the sidecar runs for the lifetime of the desktop app session and
// skills ship as immutable bundle resources, so we cache forever. The SaaS
// loader uses a 5-min TTL because its skills volume is mutable (admin can
// drop new skill packs without restarting the agent runner); that doesn't
// apply on the desktop.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parsed skill metadata + full markdown body. The sidecar serves this whole
 * shape to the LLM when it calls `invoke_skill` — the body is what the LLM
 * actually needs to follow the skill's instructions.
 */
export interface DesktopSkill {
  /** Directory name, slug-form (matches the SaaS catalog id). */
  readonly id: string;
  /** Frontmatter `name` field, falls back to `id`. */
  readonly name: string;
  /** First ~160 chars of description, single-line. UI-friendly. */
  readonly description: string;
  /** Full description from frontmatter, untruncated. */
  readonly fullDescription: string;
  /** Normalized category. Inferred from name+description if frontmatter omits it. */
  readonly category: string;
  /**
   * Either {'biomni'} or {'community'} or {'lab'} — same source taxonomy
   * the SaaS uses so the desktop UI can render a consistent badge.
   */
  readonly source: 'biomni' | 'community' | 'lab';
  /** Full markdown body (including frontmatter). The LLM reads this. */
  readonly body: string;
  /** Frontmatter allowed-tools list, if present. Used by future shell exec gate. */
  readonly allowedTools: readonly string[];
  /**
   * Heuristic: true if the skill needs an NVIDIA NGC / NVAIE API key to
   * actually run. We use this to grey the card out in the desktop UI and to
   * refuse to expose it as an LLM tool until the user has supplied a key.
   * Detection rules (any one is enough):
   *  - directory name ends with `-nim` (the NIM family)
   *  - markdown body mentions `NVIDIA_API_KEY` or `NGC_API_KEY`
   */
  readonly requiresApiKey: boolean;
  /**
   * Heuristic: true if the skill assumes a local NVIDIA GPU. Detection:
   *  - body mentions `nvidia-smi` or `cuda` (case-insensitive)
   *  - directory name matches the `proteina-complexa` or `kermt` families,
   *    both of which require a GPU even when their markdown body is light
   *    on explicit CUDA references
   */
  readonly requiresGpu: boolean;
}

interface SkillFrontmatter {
  readonly raw: Record<string, string>;
  /** allowed-tools may be a YAML scalar list `[Bash, Read]` or comma list. */
  readonly allowedTools: readonly string[];
}

/**
 * Frontmatter parser — ported verbatim from `community-skills.ts` so the
 * desktop catalog matches the SaaS catalog byte-for-byte on the same input.
 * Two value shapes handled:
 *   `key: value`            — single-line scalar
 *   `key: >` or `key: |`    — folded/literal block, continuation lines folded
 *
 * We don't pull in a real YAML lib: corpus is shallow + bundling `yaml` adds
 * ~30 kB to a sidecar where every kB matters.
 */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  const fm: Record<string, string> = {};
  if (!fmMatch) return { raw: fm, allowedTools: [] };
  const lines = fmMatch[1]?.split('\n') ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const inline = /^(\w[\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!inline) continue;
    let val = inline[2] ?? '';
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      // Block scalar: gather indented continuation lines until a blank or a
      // new top-level key. Folded (`>`) joins with spaces, literal (`|`) with
      // newlines — same convention the YAML 1.2 spec uses.
      const parts: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (next.length === 0) {
          j++;
          continue;
        }
        if (/^\w[\w-]*:/.test(next)) break;
        parts.push(next.replace(/^\s+/, '').trimEnd());
        j++;
      }
      val = parts.join(val.startsWith('|') ? '\n' : ' ').trim();
      i = j - 1;
    } else if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const key = inline[1];
    if (key) fm[key] = val;
  }

  // allowed-tools is usually `Bash, Read, Write` (comma list, possibly with
  // brackets). Normalize to a string array; drop empty entries.
  const toolsRaw = (fm['allowed-tools'] ?? '').trim();
  const allowedTools = toolsRaw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { raw: fm, allowedTools };
}

/**
 * Best-effort category inference. The SaaS catalog has the same buckets;
 * the rules below are intentionally conservative — when in doubt we return
 * `general` rather than mis-label, so the UI's category filter doesn't lie.
 */
function inferCategory(name: string, description: string): string {
  const haystack = `${name} ${description}`.toLowerCase();
  if (/scrna|single.?cell|seurat|cell.?type|annotation|cellchat/.test(haystack))
    return 'transcriptomics';
  if (/rna.?seq|bulk.?expression|deseq|edger|salmon|kallisto/.test(haystack)) return 'transcriptomics';
  if (/chip.?seq|atac.?seq|methylation|histone|chromatin|enhancer/.test(haystack)) return 'epigenomics';
  if (/proteomic|mass.?spec|metabolom|lipidom/.test(haystack)) return 'proteomics_metabolomics';
  if (/pubmed|literature|paper|abstract|citation/.test(haystack)) return 'literature';
  if (/alphafold|protein.?struct|pdb|docking|rfdiffusion|esm/.test(haystack)) return 'molecular_design';
  if (/clinicaltrial|drug.?repurpos|cmap|lincs|target.?disease/.test(haystack)) return 'drug_discovery';
  if (/variant|gwas|mutation|cnv|vcf|maf/.test(haystack)) return 'genomics_genetics';
  if (/pathway|enrich|gsea|go.?term|kegg|reactome/.test(haystack)) return 'pathway_analysis';
  if (/manuscript|report|figure|slide|ppt|pptx|pdf/.test(haystack)) return 'reporting';
  if (/integrat/.test(haystack)) return 'integration';
  if (/multi.?omics/.test(haystack)) return 'multi_omics';
  return 'general';
}

function detectRequiresApiKey(dirName: string, body: string): boolean {
  if (/-nim$/.test(dirName)) return true;
  if (/NVIDIA_API_KEY|NGC_API_KEY/.test(body)) return true;
  return false;
}

function detectRequiresGpu(dirName: string, body: string): boolean {
  if (/proteina-complexa|kermt/.test(dirName)) return true;
  // `cuda` is a noisy substring — match on word boundaries so e.g. `accumulator`
  // doesn't trip it (it won't, but better safe). nvidia-smi is unambiguous.
  if (/\bnvidia-smi\b/i.test(body)) return true;
  if (/\bcuda\b/i.test(body)) return true;
  return false;
}

function parseSkill(absDir: string, dirName: string): DesktopSkill | null {
  const mdPath = path.join(absDir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  let body: string;
  try {
    body = fs.readFileSync(mdPath, 'utf-8');
  } catch {
    return null;
  }

  const fm = parseFrontmatter(body);
  const name = fm.raw['name'] || dirName;
  const fullDescription = fm.raw['description'] || '';
  const description = fullDescription.replace(/\s+/g, ' ').slice(0, 160).trim();
  const rawCategory = (fm.raw['category'] || '').trim().toLowerCase().replace(/[-\s]/g, '_');
  const category = rawCategory || inferCategory(name, fullDescription);
  const source: DesktopSkill['source'] = dirName.startsWith('bio-') ? 'biomni' : 'community';

  return {
    id: dirName,
    name,
    description,
    fullDescription,
    category,
    source,
    body,
    allowedTools: fm.allowedTools,
    requiresApiKey: detectRequiresApiKey(dirName, body),
    requiresGpu: detectRequiresGpu(dirName, body),
  };
}

/** Cache: one snapshot for the lifetime of the sidecar process. */
let cached: ReadonlyArray<DesktopSkill> | null = null;

/**
 * Resolve where the skills live. The desktop ships them as a bundle resource
 * and the Rust supervisor passes the absolute resource path through
 * `BIOCLAW_SKILLS_DIR`. For sidecar-dev (`npm run dev`) we fall back to a
 * sibling `skills/` directory at the repo root, which is what
 * `scripts/vendor-skills.sh` populates.
 */
function resolveSkillsDir(): string | null {
  const fromEnv = process.env['BIOCLAW_SKILLS_DIR'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Dev fallback: repo-root /skills next to the sidecar source.
  const candidate = path.resolve(process.cwd(), 'skills');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

/**
 * Force-reload (test helper). Production callers should use `loadSkills`,
 * which respects the cache. This function exists so the eventual unit tests
 * around the loader can re-parse after writing a fixture skill.
 */
export function clearSkillsCache(): void {
  cached = null;
}

/** Walk the skills directory once and return all parseable skills. */
export function loadSkills(): ReadonlyArray<DesktopSkill> {
  if (cached) return cached;
  const dir = resolveSkillsDir();
  if (!dir) {
    process.stderr.write(
      'sidecar: BIOCLAW_SKILLS_DIR unset and no fallback ./skills/; skills registry will be empty\n',
    );
    cached = [];
    return cached;
  }
  if (!fs.existsSync(dir)) {
    process.stderr.write(`sidecar: skills dir not found at ${dir}\n`);
    cached = [];
    return cached;
  }
  const out: DesktopSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sidecar: failed to read skills dir ${dir}: ${msg}\n`);
    cached = [];
    return cached;
  }
  for (const entry of entries) {
    // Accept directories AND symlinks-to-directories. The SaaS allows symlinks
    // so a big BioNeMo toolkit pack can live on a data volume and be pointed
    // to from container/skills/; the desktop currently uses real copies but
    // keep the symlink path so a future "user-contributed skills" feature
    // can drop a link without rebuilding.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (!fs.statSync(abs).isDirectory()) continue;
      } catch {
        continue; // broken symlink — skip silently
      }
    }
    const parsed = parseSkill(abs, entry.name);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  cached = out;
  return cached;
}
