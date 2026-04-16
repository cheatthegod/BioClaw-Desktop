import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const SSH_HOST_PATTERN = /^[A-Za-z0-9._-]+$/;
const SSH_CONNECT_TIMEOUT_MS = 10_000;
const SSH_COMMAND_TIMEOUT_MS = 60_000;
const SSH_OUTPUT_LIMIT = 12_000;

export interface HostSshExecution {
  host: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface HostSshProbe {
  host: string;
  hostname: string;
  user: string;
  cwd: string;
  durationMs: number;
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function parseAllowedHostsOverride(): string[] | null {
  const raw = process.env.BIOCLAW_SSH_ALLOWED_HOSTS;
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && SSH_HOST_PATTERN.test(item));
  return Array.from(new Set(values));
}

export function listAllowedSshHosts(): string[] {
  const overridden = parseAllowedHostsOverride();
  if (overridden && overridden.length > 0) return overridden;

  const sshConfigPath = path.join(getHomeDir(), '.ssh', 'config');
  if (!fs.existsSync(sshConfigPath)) return [];

  const aliases = new Set<string>();
  const content = fs.readFileSync(sshConfigPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = line.match(/^Host\s+(.+)$/i);
    if (!match) continue;
    for (const candidate of match[1]!.split(/\s+/)) {
      if (!SSH_HOST_PATTERN.test(candidate)) continue;
      if (/[*?!]/.test(candidate)) continue;
      aliases.add(candidate);
    }
  }

  return Array.from(aliases).sort((a, b) => a.localeCompare(b));
}

function ensureAllowedHost(host: string): string {
  const normalized = host.trim();
  if (!SSH_HOST_PATTERN.test(normalized)) {
    throw new Error(`Invalid SSH host alias: ${host}`);
  }
  const allowedHosts = listAllowedSshHosts();
  if (!allowedHosts.includes(normalized)) {
    throw new Error(
      allowedHosts.length > 0
        ? `SSH host is not allowed: ${normalized}. Allowed hosts: ${allowedHosts.join(', ')}`
        : `SSH host is not allowed: ${normalized}. No SSH host aliases are configured.`,
    );
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function trimOutput(value: string): string {
  if (value.length <= SSH_OUTPUT_LIMIT) return value;
  return `${value.slice(0, SSH_OUTPUT_LIMIT)}\n... [truncated ${value.length - SSH_OUTPUT_LIMIT} chars]`;
}

async function runSshRemoteCommand(
  host: string,
  remoteCommand: string,
): Promise<HostSshExecution> {
  const startedAt = Date.now();
  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.ceil(SSH_CONNECT_TIMEOUT_MS / 1000)}`,
    host,
    remoteCommand,
  ];

  return await new Promise<HostSshExecution>((resolve, reject) => {
    const child = spawn('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, SSH_COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        host,
        command: remoteCommand,
        exitCode: typeof code === 'number' ? code : 255,
        stdout: trimOutput(stdout.trim()),
        stderr: trimOutput(stderr.trim()),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export async function probeSshHost(host: string): Promise<HostSshProbe> {
  const targetHost = ensureAllowedHost(host);
  const probeCommand = "printf 'HOSTNAME=%s\\n' \"$(hostname)\"; printf 'USER=%s\\n' \"$(whoami)\"; printf 'PWD=%s\\n' \"$PWD\"";
  const result = await runSshRemoteCommand(targetHost, `bash -lc ${shellQuote(probeCommand)}`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `SSH probe failed for ${targetHost}.`);
  }

  const values = Object.fromEntries(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('=');
        return idx >= 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ''];
      }),
  );

  return {
    host: targetHost,
    hostname: values.HOSTNAME || targetHost,
    user: values.USER || 'unknown',
    cwd: values.PWD || '~',
    durationMs: result.durationMs,
  };
}

export async function runSshCommand(host: string, command: string): Promise<HostSshExecution> {
  const targetHost = ensureAllowedHost(host);
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new Error('SSH command cannot be empty.');
  }
  const result = await runSshRemoteCommand(targetHost, `bash -lc ${shellQuote(trimmedCommand)}`);
  return {
    ...result,
    command: trimmedCommand,
  };
}
