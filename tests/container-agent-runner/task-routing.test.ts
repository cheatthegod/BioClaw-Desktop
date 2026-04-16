import { describe, expect, it } from 'vitest';

import {
  detectTaskRouting,
  extractLatestUserMessage,
  extractWorkspacePaths,
  mergeSkillSelections,
} from '../../container/agent-runner/src/task-routing.js';

describe('task-routing', () => {
  it('extracts workspace paths from local-web prompts', () => {
    const prompt = [
      '<messages>',
      '<message chat="thread-1@local.web" sender="Web User" time="2026-04-15T11:07:58.445Z">Uploaded file: SEC.zip',
      'Workspace path: uploads/1776251278415-SEC.zip',
      'Preview URL: /files/chat/thread-1%40local.web/uploads/1776251278415-SEC.zip</message>',
      '</messages>',
    ].join('\n');

    expect(extractWorkspacePaths(prompt)).toEqual([
      '/workspace/group/uploads/1776251278415-SEC.zip',
    ]);
  });

  it('detects SEC report tasks and forces sec-report workflow', () => {
    const prompt = [
      '<messages>',
      '<message chat="thread-1@local.web" sender="Web User" time="2026-04-15T11:07:58.445Z">Uploaded file: SEC.zip',
      'Workspace path: uploads/1776251278415-SEC.zip',
      'Preview URL: /files/chat/thread-1%40local.web/uploads/1776251278415-SEC.zip</message>',
      '<message chat="thread-1@local.web" sender="Web User" time="2026-04-15T11:07:59.891Z">You are an expert in protein biophysics and SEC (size-exclusion chromatography) analysis. Generate a comprehensive PDF report for these oligomer assembly chromatograms.</message>',
      '</messages>',
    ].join('\n');

    const decision = detectTaskRouting(prompt);
    expect(decision).not.toBeNull();
    expect(decision?.matchedRoute).toBe('sec-report');
    expect(decision?.requiredSkills).toEqual(['sec-report']);
    expect(decision?.systemBlock).toContain('/home/node/.claude/skills/sec-report/SKILL.md');
    expect(decision?.systemBlock).toContain(
      'python3 sec_pipeline.py --input /workspace/group/uploads/1776251278415-SEC.zip --output /workspace/group/sec_analysis/output',
    );
    expect(decision?.systemBlock).toContain('Do NOT assemble the report manually with matplotlib PdfPages');
  });

  it('does not route unrelated security text to sec-report', () => {
    const prompt = [
      '<messages>',
      '<message chat="thread-1@local.web" sender="Web User" time="2026-04-15T11:10:00.000Z">Please write a security report for our authentication system and review the security section of the README.</message>',
      '</messages>',
    ].join('\n');

    expect(detectTaskRouting(prompt)).toBeNull();
  });

  it('keeps only non-required preferred skills after merging', () => {
    expect(
      mergeSkillSelections(['bio-tools', 'sec-report', 'blast-search'], ['sec-report']),
    ).toEqual({
      preferred: ['bio-tools', 'blast-search'],
      required: ['sec-report'],
    });
  });

  it('extracts the latest user message from message XML prompts', () => {
    const prompt = [
      '<messages>',
      '<message chat="thread-1@local.web" sender="Web User" time="1">first</message>',
      '<message chat="thread-1@local.web" sender="Web User" time="2">second</message>',
      '</messages>',
    ].join('\n');

    expect(extractLatestUserMessage(prompt)).toBe('second');
  });
});
