/**
 * Notebook Export — generates reproducible Jupyter notebooks (.ipynb)
 * from agent trace events captured during a container run.
 *
 * Extracts code from structured tool input objects (no text matching):
 *   - Bash tool: input.command → code cell
 *   - Write tool: input.file_path + input.content → code cell (for .py) or markdown
 *   - Agent thinking: text → markdown cell
 */
import fs from 'fs';
import path from 'path';

import { getAgentTraceEvents, type AgentTraceRow } from './db/index.js';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// --- .ipynb JSON types ---

interface NotebookCell {
  cell_type: 'code' | 'markdown';
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

interface Notebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: {
    kernelspec: { display_name: string; language: string; name: string };
    language_info: { name: string; version: string };
    bioclaw?: Record<string, unknown>;
  };
  cells: NotebookCell[];
}

// --- Tool input interfaces (structured, from SDK) ---

interface BashToolInput {
  command?: string;
}

interface WriteToolInput {
  file_path?: string;
  content?: string;
}

interface EditToolInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

// --- Helpers ---

function makeMarkdownCell(lines: string[]): NotebookCell {
  return {
    cell_type: 'markdown',
    metadata: {},
    source: lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)),
  };
}

function makeCodeCell(code: string, language?: string): NotebookCell {
  const lines = code.split('\n');
  return {
    cell_type: 'code',
    metadata: language ? { language } : {},
    source: lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)),
    execution_count: null,
    outputs: [],
  };
}

function safeJsonParse<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

const PYTHON_EXTENSIONS = new Set(['.py', '.pyx', '.pyi']);

function isPythonFile(filePath: string): boolean {
  return PYTHON_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Get the full tool input from a trace event payload.
 * Prefers toolInputFull (uncapped) over toolInput (1000 char preview).
 */
function getFullToolInput(payload: Record<string, unknown>): string | undefined {
  const full = payload.toolInputFull;
  if (typeof full === 'string') return full;
  const preview = payload.toolInput;
  if (typeof preview === 'string') return preview;
  return undefined;
}

// --- Core export logic ---

function traceEventsToCells(events: AgentTraceRow[]): NotebookCell[] {
  const cells: NotebookCell[] = [];

  for (const event of events) {
    const payload = safeJsonParse<Record<string, unknown>>(event.payload);
    if (!payload) continue;

    if (event.type === 'agent_thinking') {
      const text = payload.text;
      if (typeof text === 'string' && text.trim()) {
        cells.push(makeMarkdownCell([text.trim()]));
      }
      continue;
    }

    if (event.type === 'agent_tool_use') {
      const toolName = payload.toolName;
      const rawInput = getFullToolInput(payload);
      if (typeof toolName !== 'string' || !rawInput) continue;

      const input = safeJsonParse<Record<string, unknown>>(rawInput);
      if (!input) continue;

      // Bash tool → code cell (Claude SDK: 'Bash', OpenAI: 'bash')
      if (toolName === 'Bash' || toolName === 'bash') {
        const { command } = input as BashToolInput;
        if (command) {
          // Detect python heredoc: `python3 << 'EOF'\n...\nEOF`
          const heredocMatch = command.match(
            /^python3?\s+<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1\s*$/,
          );
          if (heredocMatch) {
            cells.push(makeCodeCell(heredocMatch[2], 'python'));
          } else {
            cells.push(makeCodeCell(command, 'bash'));
          }
        }
        continue;
      }

      // Write tool → code cell if Python, otherwise describe in markdown
      // Claude SDK: 'Write', OpenAI: 'write_file'
      if (toolName === 'Write' || toolName === 'write_file') {
        const { file_path: fp, content } = input as WriteToolInput;
        if (fp && content) {
          if (isPythonFile(fp)) {
            cells.push(makeMarkdownCell([`**Write** \`${fp}\``]));
            cells.push(makeCodeCell(content, 'python'));
          } else {
            cells.push(makeMarkdownCell([
              `**Write** \`${fp}\``,
              '',
              '```',
              content.length > 500 ? content.slice(0, 500) + '\n... (truncated)' : content,
              '```',
            ]));
          }
        }
        continue;
      }

      // Edit tool → describe the change (Claude SDK only, no OpenAI equivalent)
      if (toolName === 'Edit') {
        const { file_path: fp, old_string, new_string } = input as EditToolInput;
        if (fp) {
          const lines = [`**Edit** \`${fp}\``];
          if (old_string && new_string) {
            lines.push('', '```diff');
            for (const l of old_string.split('\n').slice(0, 10)) lines.push(`- ${l}`);
            for (const l of new_string.split('\n').slice(0, 10)) lines.push(`+ ${l}`);
            lines.push('```');
          }
          cells.push(makeMarkdownCell(lines));
        }
        continue;
      }

      // Skip IPC tools that aren't reproducible analysis steps
      if (toolName === 'send_message' || toolName === 'send_image') continue;

      // Other tools (Read, Grep, Glob, WebSearch, etc.) → brief markdown note
      cells.push(makeMarkdownCell([`**${toolName}** ${rawInput.slice(0, 200)}`]));
    }
  }

  return cells;
}

/**
 * Generate a Jupyter notebook from trace events of a single agent run.
 *
 * @param groupFolder - workspace folder to query traces for
 * @param runStartedAt - ISO timestamp of container_spawn (lower bound)
 * @param runEndedAt - ISO timestamp of run_end (upper bound)
 * @param prompt - the user prompt that triggered this run
 */
export function generateNotebook(
  groupFolder: string,
  runStartedAt: string,
  runEndedAt: string,
  prompt?: string,
): Notebook | null {
  // Fetch all trace events for this group (ordered by id DESC, so reverse)
  const allEvents = getAgentTraceEvents({
    group_folder: groupFolder,
    limit: 2000,
  });

  // Filter to events within the run time window
  const events = allEvents
    .filter((e) => {
      const t = e.created_at;
      return t >= runStartedAt && t <= runEndedAt;
    })
    .reverse(); // chronological order (DB returns newest first)

  // Only keep thinking and tool_use events
  const relevant = events.filter(
    (e) => e.type === 'agent_thinking' || e.type === 'agent_tool_use',
  );

  if (relevant.length === 0) return null;

  const cells = traceEventsToCells(relevant);
  if (cells.length === 0) return null;

  // Prepend metadata header cell
  const date = new Date(runStartedAt).toISOString().slice(0, 19).replace('T', ' ');
  const headerLines = [
    `# BioClaw Analysis`,
    '',
    `**Date:** ${date}  `,
    `**Workspace:** ${groupFolder}  `,
  ];
  if (prompt) {
    headerLines.push('', `**Prompt:** ${prompt}`);
  }
  headerLines.push(
    '',
    '---',
    '',
    '*Auto-generated reproducible notebook. Cells can be re-run to reproduce results.*',
  );
  cells.unshift(makeMarkdownCell(headerLines));

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: '3.11',
      },
      bioclaw: {
        generated_at: new Date().toISOString(),
        group_folder: groupFolder,
        run_started_at: runStartedAt,
        run_ended_at: runEndedAt,
      },
    },
    cells,
  };
}

/**
 * Generate and save a notebook for a completed agent run.
 * Saves to groups/{folder}/notebooks/{timestamp}.ipynb
 * Returns the file path if successful, null otherwise.
 */
export function exportNotebook(
  groupFolder: string,
  runStartedAt: string,
  runEndedAt: string,
  prompt?: string,
): string | null {
  try {
    const notebook = generateNotebook(groupFolder, runStartedAt, runEndedAt, prompt);
    if (!notebook) {
      logger.debug({ groupFolder }, 'No notebook-worthy trace events for this run');
      return null;
    }

    const nbDir = path.join(GROUPS_DIR, groupFolder, 'notebooks');
    fs.mkdirSync(nbDir, { recursive: true });

    const ts = new Date(runStartedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nbPath = path.join(nbDir, `${ts}.ipynb`);
    fs.writeFileSync(nbPath, JSON.stringify(notebook, null, 2));

    logger.info(
      { groupFolder, nbPath, cells: notebook.cells.length },
      'Notebook exported',
    );
    return nbPath;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to export notebook');
    return null;
  }
}