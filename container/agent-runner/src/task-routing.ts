import path from 'path';

const WORKSPACE_GROUP_ROOT = '/workspace/group';
const SEC_ROUTE_SKILL = 'sec-report';

export interface TaskRoutingDecision {
  matchedRoute: 'sec-report';
  requiredSkills: string[];
  systemBlock: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractMessageBodies(prompt: string): string[] {
  const matches = prompt.match(/<message\b[\s\S]*?>([\s\S]*?)<\/message>/gi) || [];
  const bodies: string[] = [];

  for (const match of matches) {
    const start = match.indexOf('>');
    const end = match.lastIndexOf('</message>');
    if (start === -1 || end === -1 || end <= start) continue;
    bodies.push(match.slice(start + 1, end).trim());
  }

  return bodies;
}

export function extractLatestUserMessage(prompt: string): string {
  const bodies = extractMessageBodies(prompt);
  if (bodies.length === 0) return prompt.trim();
  return bodies[bodies.length - 1] || prompt.trim();
}

function normalizeWorkspacePath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return null;

  if (trimmed.startsWith(WORKSPACE_GROUP_ROOT)) {
    return path.posix.normalize(trimmed);
  }

  if (trimmed.startsWith('/')) return null;
  return path.posix.normalize(path.posix.join(WORKSPACE_GROUP_ROOT, trimmed));
}

export function extractWorkspacePaths(prompt: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  const pushPath = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const normalized = normalizeWorkspacePath(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  };

  const workspacePathMatches = prompt.matchAll(/^Workspace path:\s*(.+)$/gim);
  for (const match of workspacePathMatches) {
    const candidate = match[1]?.split('Preview URL:')[0]?.trim();
    pushPath(candidate);
  }

  const absoluteMatches = prompt.matchAll(/\/workspace\/group\/[^\s<>"')\]]+/g);
  for (const match of absoluteMatches) {
    pushPath(match[0]);
  }

  return results;
}

function isStructuredDataInput(filePath: string): boolean {
  return /\.(zip|csv|tsv|txt|xlsx?)$/i.test(filePath);
}

function pickPrimarySecInput(paths: string[]): string | undefined {
  const structured = paths.filter(isStructuredDataInput);
  const secNamed = structured.find((entry) => /sec|chromat|oligo|assembly/i.test(entry));
  return secNamed || structured[0];
}

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function looksLikeSecReportRequest(prompt: string): boolean {
  const latest = normalizeWhitespace(extractLatestUserMessage(prompt).toLowerCase());
  const allText = normalizeWhitespace(prompt.toLowerCase());
  const workspacePaths = extractWorkspacePaths(prompt);

  const domainPatterns = [
    /\bsec\b/,
    /size[-\s]?exclusion/,
    /gel filtration/,
    /chromatograph/,
    /oligomer/,
    /protein assembly/,
  ];
  const analysisPatterns = [
    /\banaly[sz]e\b/,
    /\banalysis\b/,
    /\breport\b/,
    /\bpdf\b/,
    /\bgenerate\b/,
    /\btechnical\b/,
    /\bclassif(?:y|ication)\b/,
    /comprehensive/,
  ];

  const domainScore = countMatches(latest, domainPatterns);
  const analysisScore = countMatches(latest, analysisPatterns);
  const hasUploadSignal =
    workspacePaths.some(isStructuredDataInput) ||
    /uploaded file:/i.test(allText) ||
    /workspace path:/i.test(allText);

  if (domainScore >= 2 && analysisScore >= 1 && hasUploadSignal) return true;

  const explicitPipelineRequest =
    /sec report/.test(latest) ||
    /size[-\s]?exclusion.+report/.test(latest) ||
    /chromatograph.+report/.test(latest);
  if (explicitPipelineRequest) return true;

  return false;
}

export function detectTaskRouting(prompt: string): TaskRoutingDecision | null {
  if (!looksLikeSecReportRequest(prompt)) return null;

  const inputPaths = extractWorkspacePaths(prompt);
  const primaryInput = pickPrimarySecInput(inputPaths);
  const candidateLines = inputPaths.length > 0
    ? inputPaths.map((entry) => `- ${entry}`)
    : ['- Search /workspace/group/uploads and /workspace/group for the uploaded SEC dataset.'];
  const commandLine = primaryInput
    ? `python3 sec_pipeline.py --input ${primaryInput} --output /workspace/group/sec_analysis/output`
    : 'python3 sec_pipeline.py --input <uploaded-sec-dataset> --output /workspace/group/sec_analysis/output';

  return {
    matchedRoute: 'sec-report',
    requiredSkills: [SEC_ROUTE_SKILL],
    systemBlock: [
      '',
      '[Automatic task routing]',
      'This task has been classified as an SEC chromatography analysis/report job.',
      `Required skill module: ${SEC_ROUTE_SKILL}`,
      'You MUST follow the installed sec-report workflow for this task.',
      '',
      'Candidate input paths detected from the conversation:',
      ...candidateLines,
      '',
      'Required workflow:',
      '1. Read /home/node/.claude/skills/sec-report/SKILL.md',
      '2. Send the short "SEC Analysis Plan" message requested by the skill before execution.',
      '3. Run the bundled pipeline exactly as instructed:',
      '   cd /home/node/.claude/skills/sec-report',
      `   ${commandLine}`,
      '4. Send /workspace/group/sec_analysis/output/SEC_Analysis_Report.pdf to the user.',
      '5. Send /workspace/group/sec_analysis/output/figures/ranking_summary.png to the user.',
      '6. Summarize findings using /workspace/group/sec_analysis/output/analysis_summary.json.',
      '',
      'Forbidden for this task:',
      '- Do NOT write ad-hoc SEC analysis scripts.',
      '- Do NOT assemble the report manually with matplotlib PdfPages or custom markdown-to-PDF code.',
      '- Do NOT save manual report artifacts under /workspace/group/SEC_report.',
      '- Do NOT skip sec_pipeline.py if the goal is a new SEC analysis/report deliverable.',
      '',
      'If the pipeline fails, explain the failure and troubleshoot it. Only fall back to manual analysis if the pipeline is genuinely incompatible and you clearly say why.',
      '',
    ].join('\n'),
  };
}

export function mergeSkillSelections(
  preferredSkills?: string[],
  requiredSkills?: string[],
): { preferred: string[]; required: string[] } {
  const preferred = Array.isArray(preferredSkills)
    ? preferredSkills.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const required = Array.isArray(requiredSkills)
    ? requiredSkills.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  const requiredSet = new Set(required);
  return {
    required,
    preferred: preferred.filter((entry) => !requiredSet.has(entry)),
  };
}
