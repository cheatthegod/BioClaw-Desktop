/**
 * Local Runner — runs agent-runner as a local Node.js subprocess
 * instead of inside a Docker container.
 *
 * Same input/output protocol as container-runner.ts:
 *   - Input:  JSON on stdin (ContainerInput)
 *   - Output: stdout markers ---BIOCLAW_OUTPUT_START--- / ---BIOCLAW_OUTPUT_END---
 *   - IPC:    file-based in ctx.ipcDirForAgent(agentId)
 *
 * Environment variables map container paths to local directories:
 *   BIOCLAW_GROUP_ROOT, BIOCLAW_IPC_ROOT, BIOCLAW_GLOBAL_ROOT,
 *   BIOCLAW_EXTRA_ROOT, BIOCLAW_SKILLS_ROOT, BIOCLAW_CLAUDE_HOME
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getRuntime, RuntimeContext } from './runtime-context.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { recordAgentTraceEvent } from './agent-trace.js';
import { getWorkspaceFolder } from './workspace.js';
import type { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// ── Output markers (must match agent-runner/src/index.ts) ──
const OUTPUT_START_MARKER = '---BIOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---BIOCLAW_OUTPUT_END---';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;  // 10 MB

/**
 * Run an agent as a local Node.js subprocess.
 * API-compatible with runContainerAgent() from container-runner.ts.
 */
export async function runLocalAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const ctx = getRuntime();
  const startTime = Date.now();
  const workspaceFolder = getWorkspaceFolder(group);
  const agentId = input.agentId || workspaceFolder;

  // ── Prepare directories ──
  const groupDir = ctx.groupDir(workspaceFolder);
  const ipcDir = ctx.ipcDirForAgent(agentId);
  const sessionDir = ctx.sessionDirForAgent(agentId);
  const skillsDir = ctx.skillsDirForAgent(agentId);
  const globalDir = path.join(ctx.groupsDir, 'global');
  const logsDir = ctx.logsDir(workspaceFolder);

  for (const dir of [
    groupDir, ipcDir,
    path.join(ipcDir, 'input'),
    path.join(ipcDir, 'messages'),
    path.join(ipcDir, 'tasks'),
    path.join(ipcDir, 'files'),
    sessionDir, logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Sync skills if not present, rewriting container paths to local paths
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    try {
      fs.cpSync(ctx.skillsDir, skillsDir, { recursive: true });
      // Rewrite hardcoded container paths in SKILL.md files
      rewriteSkillPaths(skillsDir, groupDir, skillsDir);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to copy/rewrite skills to session dir');
    }
  }

  // ── Build environment ──
  const pythonBinDir = path.dirname(ctx.pythonPath);
  const currentPath = process.env.PATH || '';

  // Proxy env vars to pass through (critical for VPN/proxy users)
  const proxyVars: Record<string, string> = {};
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]) {
    if (process.env[key]) proxyVars[key] = process.env[key]!;
  }

  const env: Record<string, string> = {
    // Inherit minimal env
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    PATH: `${pythonBinDir}${path.delimiter}${currentPath}`,
    TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
    LANG: process.env.LANG || 'en_US.UTF-8',

    // Pass through system proxy settings
    ...proxyVars,

    // Node.js
    NODE_ENV: 'production',
    NODE_NO_WARNINGS: '1',

    // Electron: run as pure Node.js
    ELECTRON_RUN_AS_NODE: '1',

    // Node.js binary for spawning subprocesses (MCP server, etc.)
    // In desktop mode, 'node' is not in PATH — use Electron's own exe
    BIOCLAW_NODE_BIN: process.execPath,

    // Bash executable for the agent-runner Bash tool. Two env vars for
    // two code paths:
    //
    //   BIOCLAW_BASH_BIN         — read by our own runBashTool() in
    //                              container/agent-runner/src/index.ts
    //                              (the OpenAI-compatible tool loop).
    //
    //   CLAUDE_CODE_GIT_BASH_PATH — the official variable the Claude
    //                              Agent SDK reads when its own Bash
    //                              tool runs on Windows. Without it,
    //                              the Anthropic provider code path
    //                              still falls back to '/bin/bash' and
    //                              fails with ENOENT on Windows.
    //
    // Set both to keep parity whichever provider the user picks.
    ...(ctx.bashPath
      ? {
          BIOCLAW_BASH_BIN: ctx.bashPath,
          CLAUDE_CODE_GIT_BASH_PATH: ctx.bashPath,
        }
      : {}),

    // BioClaw path mapping (agent-runner reads these)
    BIOCLAW_GROUP_ROOT: groupDir,
    BIOCLAW_IPC_ROOT: ipcDir,
    BIOCLAW_GLOBAL_ROOT: globalDir,
    BIOCLAW_EXTRA_ROOT: path.join(ctx.groupsDir, '_extra'),
    BIOCLAW_SKILLS_ROOT: skillsDir,
    BIOCLAW_CLAUDE_HOME: sessionDir,

    // API credentials — set based on provider type
    ...(ctx.providerType === 'anthropic'
      ? { ANTHROPIC_API_KEY: ctx.apiKey }
      : ctx.providerType === 'openrouter'
        ? {
            MODEL_PROVIDER: 'openrouter',
            OPENROUTER_API_KEY: ctx.apiKey,
            OPENROUTER_BASE_URL: ctx.providerBaseUrl || 'https://openrouter.ai/api/v1',
            ...(ctx.providerModel ? { OPENROUTER_MODEL: ctx.providerModel } : {}),
          }
        : {
            // custom provider
            MODEL_PROVIDER: 'openai-compatible',
            OPENAI_COMPATIBLE_API_KEY: ctx.apiKey,
            OPENAI_COMPATIBLE_BASE_URL: ctx.providerBaseUrl,
            ...(ctx.providerModel ? { OPENAI_COMPATIBLE_MODEL: ctx.providerModel } : {}),
          }),
  };

  // Per-agent runtime config overrides (from control-plane /provider command)
  if (input.runtimeConfig?.provider) {
    env.MODEL_PROVIDER = input.runtimeConfig.provider;
  }
  if (input.runtimeConfig?.model) {
    if (input.runtimeConfig.provider === 'openai-compatible') {
      env.OPENAI_COMPATIBLE_MODEL = input.runtimeConfig.model;
    }
  }
  if (input.runtimeConfig?.baseUrl) {
    if (input.runtimeConfig.provider === 'openai-compatible') {
      env.OPENAI_COMPATIBLE_BASE_URL = input.runtimeConfig.baseUrl;
    }
  }

  // Pass secrets through input (same as container-runner)
  const inputWithSecrets: ContainerInput = {
    ...input,
    secrets: {
      ANTHROPIC_API_KEY: ctx.apiKey,
      ...(input.runtimeConfig?.provider ? { MODEL_PROVIDER: input.runtimeConfig.provider } : {}),
    },
  };

  // ── Resolve agent-runner entry point ──
  const agentRunnerPath = ctx.agentRunnerPath;
  if (!agentRunnerPath || !fs.existsSync(agentRunnerPath)) {
    const errMsg = `Agent runner not found at: ${agentRunnerPath}`;
    logger.error(errMsg);
    return { status: 'error', result: null, error: errMsg };
  }

  // ── Log ──
  const processName = `local-agent-${agentId}`;
  logger.info(
    { agentId, groupDir, ipcDir, skillsDir, agentRunnerPath },
    'Spawning local agent subprocess',
  );

  recordAgentTraceEvent({
    group_folder: workspaceFolder,
    chat_jid: input.chatJid,
    session_id: input.sessionId ?? null,
    type: 'container_spawn',
    payload: {
      containerName: processName,
      agentId,
      isMain: input.isMain,
      isScheduledTask: Boolean(input.isScheduledTask),
      mode: 'local',
    },
  });

  // ── Spawn subprocess ──
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [agentRunnerPath], {
      cwd: groupDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Don't inherit parent's signal handlers
      detached: false,
    });

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;

    // Write input via stdin
    child.stdin!.write(JSON.stringify(inputWithSecrets));
    child.stdin!.end();

    // ── Parse streaming output markers ──
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    child.stdout!.on('data', (data: Buffer) => {
      const chunk = data.toString();

      // Accumulate for logging (with size limit)
      if (!stdoutTruncated) {
        const remaining = MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error({ err, agentId }, 'Error in onOutput callback');
              });
          } catch (e) {
            logger.warn({ err: e, agentId }, 'Failed to parse agent output JSON');
          }
        }
      }

      // Reset idle timeout on output
      resetTimeout();
    });

    child.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr in real-time for debugging agent crashes
      logger.error({ agentId, stderr: chunk.trim() }, 'Agent subprocess stderr');
    });

    // ── Timeout management ──
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutMs = DEFAULT_TIMEOUT_MS;

    function resetTimeout() {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        logger.warn({ agentId, elapsed: Date.now() - startTime },
          'Agent subprocess timed out — killing');
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);
    }
    resetTimeout();

    // ── Process exit ──
    child.on('close', async (code) => {
      clearTimeout(timeoutHandle);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Write log
      const logFile = path.join(
        logsDir,
        `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
      );
      try {
        fs.writeFileSync(logFile, [
          `Timestamp: ${new Date().toISOString()}`,
          `Agent: ${agentId}`,
          `Exit code: ${code}`,
          `Duration: ${elapsed}s`,
          `Mode: local`,
          '',
          '=== STDOUT ===',
          stdout.slice(0, 50000),
          '',
          '=== STDERR ===',
          stderr.slice(0, 10000),
        ].join('\n'));
      } catch { /* ignore */ }

      // Wait for all output callbacks to complete
      await outputChain;

      if (code === 0 || code === null) {
        logger.info({ agentId, elapsed }, 'Local agent completed successfully');
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
      } else {
        logger.error({ agentId, code, elapsed }, 'Local agent failed');
        resolve({
          status: 'error',
          result: null,
          error: `Agent process exited with code ${code}`,
          newSessionId,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      logger.error({ err, agentId }, 'Failed to spawn agent subprocess');
      resolve({
        status: 'error',
        result: null,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Rewrite hardcoded container paths in SKILL.md files so they point to
 * actual local directories. Only touches .md files.
 */
/**
 * Rewrite hardcoded container paths in skill files so they point to
 * actual local directories. Covers .md and .py files.
 */
function rewriteSkillPaths(
  skillsDir: string,
  groupRoot: string,
  localSkillsRoot: string,
): void {
  const replacements: [RegExp, string][] = [
    [/\/home\/node\/\.claude\/skills/g, localSkillsRoot],
    [/\/workspace\/group/g, groupRoot],
  ];
  const rewriteExtensions = new Set(['.md', '.py']);

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip test/cache directories
        if (entry.name === 'tests' || entry.name === '__pycache__') continue;
        walk(fullPath);
      } else if (rewriteExtensions.has(path.extname(entry.name))) {
        try {
          let content = fs.readFileSync(fullPath, 'utf-8');
          let changed = false;
          for (const [pattern, replacement] of replacements) {
            const newContent = content.replace(pattern, replacement);
            if (newContent !== content) {
              content = newContent;
              changed = true;
            }
          }
          if (changed) {
            fs.writeFileSync(fullPath, content);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }
  walk(skillsDir);
}
