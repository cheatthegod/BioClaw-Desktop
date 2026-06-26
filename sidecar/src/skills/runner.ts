// Skill runner — implements the `invoke_skill` tool handler.
//
// PHASE-3 minimum scope: when the LLM calls `invoke_skill(skill_id, args)`,
// we look the skill up in the registry and return its full SKILL.md body
// as the tool result, prefixed with a short instruction header. The agent
// can then either follow the skill itself (if it's pure-prose / Python /
// API-call-shaped) or read the steps to the user.
//
// What this DOESN'T do (intentional security boundary):
//   * No shell execution. Several skills include `bash` recipes — we DO NOT
//     run them. Phase 4 will add a Tauri-side permission prompt + shell
//     allow-list before shell exec is allowed.
//   * No HTTP fan-out. Some skills POST to NVIDIA NIM hosted endpoints; we
//     leave those calls to the LLM-as-orchestrator path or to a future
//     dedicated tool.
//   * No file writes. Skills like `complexa-target` edit YAML on disk;
//     phase-3 only surfaces the instructions.
//
// The hint string in the tool output makes the boundary explicit to the
// LLM so it knows not to claim it ran a skill that only printed.

import type { ToolHandlerContext, ToolHandlerResult } from '../providers-bridge';
import { getSkill } from './registry';

const HINT = [
  '',
  '---',
  '_(BioClaw Desktop sidecar: invoke_skill only LOADS the playbook. ',
  'To actually run a script the skill ships with, call `run_skill_script(skill_id, script, args)` — that path is gated by user permission and returns real stdout/stderr.)_',
].join('\n');

/**
 * Bounded-size formatter — extremely long SKILL.md bodies (some of the
 * BioNeMo Agent Toolkit ones run to 30k+ chars) blow up the LLM's context.
 * We cap at ~24 k chars, which fits comfortably in any of the providers we
 * support, and surface a tail-truncation note if we had to clip. The cap is
 * a soft heuristic; we round to a paragraph boundary when possible.
 */
const MAX_BODY_CHARS = 24_000;
function clampBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) return { text: body, truncated: false };
  const slice = body.slice(0, MAX_BODY_CHARS);
  // Try to break at the last `\n\n` so we don't cut mid-fence.
  const lastBreak = slice.lastIndexOf('\n\n');
  const cut = lastBreak > MAX_BODY_CHARS * 0.7 ? lastBreak : MAX_BODY_CHARS;
  return { text: slice.slice(0, cut), truncated: true };
}

/**
 * Tool handler. Signature is the `ToolDefinition.handler` shape from the
 * vendored agent types — args + ctx, returns `ToolHandlerResult`. Errors
 * surface as tool errors (i.e. the LLM sees them and can self-correct).
 */
export async function runSkillTool(
  args: Readonly<Record<string, unknown>>,
  _ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  const skillId = typeof args['skill_id'] === 'string' ? (args['skill_id'] as string) : '';
  if (!skillId) {
    return {
      output: 'invoke_skill: missing required argument `skill_id` (string).',
      metadata: { ok: false, reason: 'missing_skill_id' },
    };
  }
  const skill = getSkill(skillId);
  if (!skill) {
    return {
      output: `invoke_skill: no skill with id ${JSON.stringify(skillId)} is installed in this BioClaw Desktop build. Pick one from the system-prompt list.`,
      metadata: { ok: false, reason: 'unknown_skill', skill_id: skillId },
    };
  }
  const { text, truncated } = clampBody(skill.body);
  const header = [
    `# Skill: ${skill.name} (${skill.id})`,
    `Category: ${skill.category}`,
    skill.requiresApiKey ? 'Requires NVIDIA NGC / NVAIE API key.' : null,
    skill.requiresGpu ? 'Requires a local NVIDIA GPU.' : null,
    skill.allowedTools.length > 0 ? `Skill-side allowed-tools: ${skill.allowedTools.join(', ')}` : null,
    '',
    'Full SKILL.md content follows. Read it carefully and surface relevant steps to the user.',
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const body = `${header}\n${text}${truncated ? '\n\n_(SKILL.md truncated to fit context window. Ask the user if they want to see the rest.)_' : ''}${HINT}`;
  return {
    output: body,
    metadata: {
      ok: true,
      skill_id: skill.id,
      requiresApiKey: skill.requiresApiKey,
      requiresGpu: skill.requiresGpu,
      truncated,
    },
  };
}
