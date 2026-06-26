// Skills registry — thin layer over the loader that the rest of the sidecar
// queries. Three responsibilities:
//
//   1. Catalog access: `listSkills()` returns the public-facing metadata
//      (no full body, so the `GET /skills` HTTP response stays small);
//      `getSkill(id)` returns the full record including body for the
//      runner to embed in a tool result.
//
//   2. Keyword search: `searchByKeywords(text)` ranks skills by token
//      overlap with the user's chat input. The registry needs this because
//      the LLM tool we expose (`invoke_skill`) takes a skill_id — the LLM
//      can pick reliably only if the system prompt lists *relevant* skill
//      ids next to a one-line summary. Listing all 41 (or 189) every turn
//      would burn context, so we surface the top-K via the system prompt
//      and let the LLM pick from there.
//
//   3. Tool definition assembly: `buildSkillToolDefinition()` returns the
//      OpenAI-compatible function-tool spec the chat handler injects into
//      every `/chat` request. The schema is small and stable — one enum
//      over skill ids — so the LLM doesn't waste tokens describing 41
//      different tools.
//
// ## Phase-3 decision: meta-tool vs per-skill tools
//
// We expose ONE meta-tool `invoke_skill(skill_id, args)` rather than 41
// separate `bioclaw_invoke_<skill>` tools. Trade-offs:
//
//   * Meta-tool: ~150 tokens of tool schema regardless of catalog size; LLM
//     has to pick from an `enum` of ids it might not have seen before in
//     training data. We mitigate by listing the top-K relevant skills with
//     one-line descriptions in the system prompt at chat time.
//
//   * Per-skill tools: ~40-100 tokens per tool * 41 skills = ~2-4 k tokens
//     of permanent context tax. LLM gets full name + description for free
//     and can pick by reading the tool list, but the cost scales linearly
//     with the catalog.
//
// At the current ~6-skill phase-3 bundle this barely matters; we go with
// the meta-tool so the same code path scales when we eventually unlock all
// 41 skills. The `buildSkillToolDefinition` function is the ONE place to
// swap the strategy — the runner and the chat-loop don't care what shape
// the tool definition takes.

import type { JsonSchemaObject } from '../../../src/lib/mcp/types';
import type { ToolDefinition } from '../providers-bridge';
import { runSkillTool } from './runner';
import { loadSkills, type DesktopSkill } from './loader';

/** Metadata-only projection — what goes over the wire to `GET /skills`. */
export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly fullDescription: string;
  readonly category: string;
  readonly source: DesktopSkill['source'];
  readonly requiresApiKey: boolean;
  readonly requiresGpu: boolean;
  readonly allowedTools: readonly string[];
}

function toSummary(s: DesktopSkill): SkillSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    fullDescription: s.fullDescription,
    category: s.category,
    source: s.source,
    requiresApiKey: s.requiresApiKey,
    requiresGpu: s.requiresGpu,
    allowedTools: s.allowedTools,
  };
}

/** Full catalog — metadata only. Body access goes through `getSkill`. */
export function listSkills(): readonly SkillSummary[] {
  return loadSkills().map(toSummary);
}

/** Lookup by id. Returns the FULL skill record (body included). */
export function getSkill(id: string): DesktopSkill | undefined {
  return loadSkills().find((s) => s.id === id);
}

/**
 * Score-and-rank skills by how well they match free-text input. Used to
 * pick which skill descriptions to inject into the system prompt for a
 * given chat turn — see `composeSkillsSystemPrompt` below.
 *
 * Algorithm: tokenize input + each skill's (name + fullDescription + id),
 * compute weighted token overlap. Cheap, deterministic, no embeddings. The
 * SaaS uses pgvector + embeddings for the same purpose but the desktop
 * sidecar can't afford to ship an embedding model or call a remote one on
 * every chat turn.
 *
 * `limit` caps the result count; 0 or negative means "no cap".
 */
export function searchByKeywords(text: string, limit = 6): readonly SkillSummary[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);
  const scored: Array<{ skill: DesktopSkill; score: number }> = [];
  for (const s of loadSkills()) {
    const hay = tokenize(`${s.name} ${s.id} ${s.fullDescription}`);
    let score = 0;
    for (const t of hay) {
      if (tokenSet.has(t)) score++;
    }
    if (score > 0) scored.push({ skill: s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const top = limit > 0 ? scored.slice(0, limit) : scored;
  return top.map((x) => toSummary(x.skill));
}

/**
 * Tokenize for keyword search: lower-case, split on non-word, drop short
 * stop-tokens. Intentionally conservative — we don't stem ("design" and
 * "designed" don't match) because over-eager stemming made the SaaS
 * version return junk.
 */
const STOP_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'so',
  'the', 'to', 'use', 'using', 'with', 'you', 'your', 'this', 'that',
]);
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/**
 * Build the OpenAI-compatible tool-definition the chat handler injects into
 * every `/chat` request. ONE meta-tool over the whole catalog.
 *
 * The `skill_id` field is left as a free-form string rather than an `enum`
 * because we don't want the schema to blow up if the catalog has 189 ids —
 * the LLM picks based on the system-prompt summary anyway. We DO validate
 * the id server-side in the runner.
 */
export function buildSkillToolDefinition(): ToolDefinition {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description:
          'The id of the skill to invoke (e.g. "bionemo-nvmolkit"). Pick from the list of available skills in the system prompt.',
      },
      args: {
        type: 'object',
        description:
          'Optional structured arguments. Phase-3 ignores this — the SKILL.md body is returned regardless — but the field exists so the LLM can pass intent without errors.',
        additionalProperties: true,
      },
    },
    required: ['skill_id'],
    additionalProperties: false,
  };
  return {
    name: 'invoke_skill',
    description:
      'Load and consult a BioClaw skill (BioNeMo workflow / database query / scientific pipeline). Returns the full SKILL.md content so you can follow its instructions. NOTE: phase-3 does NOT execute shell commands inside the skill — surface the instructions to the user and ask before running anything that touches their system.',
    schema,
    kind: 'local',
    handler: runSkillTool,
  };
}

/**
 * Compose a short system-prompt addendum listing the most relevant skills
 * for the current user turn. The chat handler concatenates this with the
 * user-supplied system prompt before forwarding to the provider.
 *
 * Strategy: rank by keyword overlap on the LAST user message. If nothing
 * matches (no overlap with any skill), fall back to listing the first K
 * skills in the catalog — the LLM at least sees that the tool exists and
 * has SOMETHING to choose from.
 */
export function composeSkillsSystemPrompt(lastUserText: string, topK = 6): string {
  const all = listSkills();
  if (all.length === 0) return '';
  let chosen = searchByKeywords(lastUserText, topK);
  if (chosen.length === 0) chosen = all.slice(0, topK);
  const lines: string[] = [];
  lines.push('## Available BioClaw skills');
  lines.push(
    'You have access to a tool called `invoke_skill` that loads a BioClaw skill. ' +
      'Each skill is a markdown playbook for a biomedical workflow. Call it with the `skill_id` of one of the skills below when the user\'s request matches. ' +
      'The tool returns the skill\'s full SKILL.md — read it, then either follow it yourself or summarise the steps for the user. ' +
      'In this phase the tool does NOT execute shell commands; ask the user before running anything destructive.',
  );
  lines.push('');
  lines.push('Skills (top match first):');
  for (const s of chosen) {
    const flags: string[] = [];
    if (s.requiresApiKey) flags.push('needs NVIDIA API key');
    if (s.requiresGpu) flags.push('needs GPU');
    const flagsStr = flags.length > 0 ? ` _(${flags.join(', ')})_` : '';
    lines.push(`- \`${s.id}\`: ${s.description}${flagsStr}`);
  }
  return lines.join('\n');
}
