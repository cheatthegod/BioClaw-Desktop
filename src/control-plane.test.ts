import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { executeControlCommand } from './control-plane.js';
import { _initTestDatabase } from './db/index.js';
import {
  getCurrentThreadForChat,
  getAgentForChat,
  getAgentIdForChat,
  getWorkspaceFolderForChat,
  listThreadsForChat,
  loadState,
  registerGroup,
} from './session-manager.js';
import { getTaskById, getAllTasks } from './db/index.js';

describe('control-plane commands', () => {
  beforeEach(() => {
    _initTestDatabase();
    loadState();
    registerGroup('local-web@local.web', {
      name: 'Local Web Chat',
      folder: 'local-web',
      workspaceFolder: 'local-web',
      trigger: '@Bioclaw',
      added_at: '2026-03-26T00:00:00.000Z',
      requiresTrigger: false,
    });
    registerGroup('wechat-test@wechat.user', {
      name: 'WeChat Test',
      folder: 'wechat-test',
      workspaceFolder: 'shared-lab',
      trigger: '@Bioclaw',
      added_at: '2026-03-26T00:01:00.000Z',
      requiresTrigger: false,
    });
    fs.mkdirSync(path.join(GROUPS_DIR, 'local-web'), { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, 'shared-lab'), { recursive: true });
  });

  it('updates agent memory via /memory set', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      '/memory set remember-this',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('Updated memory');
    expect(getAgentForChat('local-web@local.web')?.systemPrompt).toBe('remember-this');
  });

  it('switches workspace via /workspace bind', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      '/workspace bind shared-lab',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(getWorkspaceFolderForChat('local-web@local.web')).toBe('shared-lab');
    expect(getAgentIdForChat('local-web@local.web')).toBe('shared-lab');
  });

  it('switches provider for the current agent', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');

    const result = await executeControlCommand(
      'local-web@local.web',
      '/provider switch openrouter',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.provider).toBe('openrouter');
    vi.unstubAllEnvs();
  });

  it('updates the current working directory via /dir', async () => {
    fs.mkdirSync(path.join(GROUPS_DIR, 'local-web', 'analysis'), { recursive: true });

    const result = await executeControlCommand(
      'local-web@local.web',
      '/dir analysis',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('/workspace/group/analysis');
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.workdir).toBe('analysis');
  });

  it('supports /dir history and previous-directory switching', async () => {
    fs.mkdirSync(path.join(GROUPS_DIR, 'local-web', 'analysis', 'results'), { recursive: true });

    await executeControlCommand('local-web@local.web', '/dir analysis', { channels: () => [] });
    await executeControlCommand('local-web@local.web', '/dir results', { channels: () => [] });

    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.workdir).toBe('analysis/results');

    const result = await executeControlCommand(
      'local-web@local.web',
      '/dir -',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.workdir).toBe('analysis');
  });

  it('rejects /dir paths that escape the workspace root', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      '/dir ../secret',
      { channels: () => [] },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('/workspace/group');
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.workdir).toBeUndefined();
  });

  it('stores and runs custom commands', async () => {
    const saved = await executeControlCommand(
      'local-web@local.web',
      '/commands add qc :: Summarize QC results for {{args}}',
      { channels: () => [] },
    );

    expect(saved.handled).toBe(true);
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.commands?.qc).toContain('{{args}}');

    const executed = await executeControlCommand(
      'local-web@local.web',
      '/commands run qc sample-42',
      { channels: () => [] },
    );

    expect(executed.handled).toBe(true);
    expect(executed.dispatchPrompt).toBe('Summarize QC results for sample-42');
  });

  it('expands aliases into custom command execution', async () => {
    await executeControlCommand(
      'local-web@local.web',
      '/commands add qc :: Summarize QC results for {{args}}',
      { channels: () => [] },
    );
    const aliasSaved = await executeControlCommand(
      'local-web@local.web',
      '/alias add quickqc :: /commands run qc',
      { channels: () => [] },
    );

    expect(aliasSaved.handled).toBe(true);
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.aliases?.quickqc).toBe('/commands run qc');

    const executed = await executeControlCommand(
      'local-web@local.web',
      '/quickqc sample-99',
      { channels: () => [] },
    );

    expect(executed.handled).toBe(true);
    expect(executed.dispatchPrompt).toBe('Summarize QC results for sample-99');
  });

  it('lists and enables preferred skills for an agent', async () => {
    const listed = await executeControlCommand(
      'local-web@local.web',
      '/skills list',
      { channels: () => [] },
    );

    expect(listed.handled).toBe(true);
    expect(listed.response).toContain('Installed skills:');

    const enabled = await executeControlCommand(
      'local-web@local.web',
      '/skills enable bio-tools blast-search',
      { channels: () => [] },
    );

    expect(enabled.handled).toBe(true);
    expect(getAgentForChat('local-web@local.web')?.runtimeConfig?.enabledSkills).toEqual([
      'bio-tools',
      'blast-search',
    ]);
  });

  it('creates cron and heartbeat tasks', async () => {
    const cron = await executeControlCommand(
      'local-web@local.web',
      '/cron add interval 5 summarize status',
      { channels: () => [] },
    );
    const heartbeat = await executeControlCommand(
      'local-web@local.web',
      '/heartbeat start 10',
      { channels: () => [] },
    );

    expect(cron.handled).toBe(true);
    expect(heartbeat.handled).toBe(true);

    const tasks = getAllTasks();
    expect(tasks.some((task) => task.label === 'cron')).toBe(true);
    expect(getTaskById(`heartbeat-${getAgentIdForChat('local-web@local.web')}`)?.label).toBe('heartbeat');
  });

  it('creates local-web threads via /new when thread factory is provided', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      '/new test-thread',
      {
        channels: () => [],
        createThread: async (title?: string) => ({
          chatJid: 'thread-abc@local.web',
          title: title || 'New chat',
          workspaceFolder: 'thread-abc',
          addedAt: '2026-03-26T00:00:00.000Z',
        }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('thread-abc@local.web');
  });

  it('creates and switches non-web chat threads via /new and /use', async () => {
    const created = await executeControlCommand(
      'wechat-test@wechat.user',
      '/new planning',
      { channels: () => [] },
    );

    expect(created.handled).toBe(true);
    expect(created.response).toContain('Created and switched');

    const createdThread = getCurrentThreadForChat('wechat-test@wechat.user');
    expect(createdThread?.title).toBe('planning');

    const switched = await executeControlCommand(
      'wechat-test@wechat.user',
      '/use WeChat Test',
      { channels: () => [] },
    );

    expect(switched.handled).toBe(true);
    expect(getCurrentThreadForChat('wechat-test@wechat.user')?.title).toBe('WeChat Test');
  });

  it('renames and archives non-web chat threads', async () => {
    await executeControlCommand(
      'wechat-test@wechat.user',
      '/new analysis',
      { channels: () => [] },
    );
    const renamed = await executeControlCommand(
      'wechat-test@wechat.user',
      '/rename Alpha plan',
      { channels: () => [] },
    );

    expect(renamed.handled).toBe(true);
    expect(getCurrentThreadForChat('wechat-test@wechat.user')?.title).toBe('Alpha plan');

    await executeControlCommand(
      'wechat-test@wechat.user',
      '/use WeChat Test',
      { channels: () => [] },
    );

    const archived = await executeControlCommand(
      'wechat-test@wechat.user',
      '/archive Alpha plan',
      { channels: () => [] },
    );

    expect(archived.handled).toBe(true);
    expect(listThreadsForChat('wechat-test@wechat.user').some((thread) => thread.title === 'Alpha plan')).toBe(false);
  });

  it('lists configured SSH hosts via /ssh list', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      '/ssh list',
      {
        channels: () => [],
        ssh: {
          listHosts: () => ['lambda-cloud-54-140', 'hpc-login'],
        },
      },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('lambda-cloud-54-140');
    expect(result.response).toContain('hpc-login');
  });

  it('supports bare ssh host probe commands in chat', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      'ssh lambda-cloud-54-140',
      {
        channels: () => [],
        ssh: {
          probeHost: async (host) => ({
            host,
            hostname: '192-222-54-140',
            user: 'ubuntu',
            cwd: '/home/ubuntu',
            durationMs: 27,
          }),
        },
      },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('SSH connected: lambda-cloud-54-140');
    expect(result.response).toContain('Hostname: 192-222-54-140');
  });

  it('runs remote commands through ssh control plane', async () => {
    const result = await executeControlCommand(
      'local-web@local.web',
      'ssh lambda-cloud-54-140 -- hostname',
      {
        channels: () => [],
        ssh: {
          runCommand: async (host, command) => ({
            host,
            command,
            exitCode: 0,
            stdout: '192-222-54-140',
            stderr: '',
            durationMs: 55,
            timedOut: false,
          }),
        },
      },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('SSH host: lambda-cloud-54-140');
    expect(result.response).toContain('Command: hostname');
    expect(result.response).toContain('192-222-54-140');
  });
});
