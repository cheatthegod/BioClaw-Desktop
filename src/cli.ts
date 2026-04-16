/**
 * BioClaw CLI Mode
 * Test the agent locally without WhatsApp.
 * Usage: npm run cli
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CONTAINER_RUNTIME,
  GROUPS_DIR,
  DATA_DIR,
} from './config.js';
import { buildContainerArgs, spawnContainer, VolumeMount } from './container-runtime.js';
import { readSecrets } from './credential-proxy.js';
import { logger } from './logger.js';
import { syncContainerSkillsToSession } from './sync-container-skills.js';

const GROUP_FOLDER = 'cli-test';

function ensureDirs() {
  const dirs = [
    path.join(GROUPS_DIR, GROUP_FOLDER, 'logs'),
    path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'messages'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'tasks'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'input'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const settingsFile = path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude', 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Copy all container/skills into CLI session (recursive)
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude', 'skills');
  syncContainerSkillsToSession(skillsSrc, skillsDst);
}

async function runAgent(prompt: string): Promise<string> {
  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, GROUP_FOLDER);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const sessionsDir = path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude');
  const ipcDir = path.join(DATA_DIR, 'ipc', GROUP_FOLDER);
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');

  const input = {
    prompt,
    groupFolder: GROUP_FOLDER,
    chatJid: 'cli@local',
    isMain: false,
    secrets: readSecrets(),
  };

  const mounts: VolumeMount[] = [
    { hostPath: groupDir, containerPath: '/workspace/group', readonly: false },
    { hostPath: globalDir, containerPath: '/workspace/global', readonly: true },
    { hostPath: sessionsDir, containerPath: '/home/node/.claude', readonly: false },
    { hostPath: ipcDir, containerPath: '/workspace/ipc', readonly: false },
    { hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true },
  ];

  const containerName = `bioclaw-cli-${Date.now()}`;
  const args = buildContainerArgs(mounts, containerName);

  const ipcInputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });
  // Remove stale close sentinel from previous runs
  try { fs.unlinkSync(path.join(ipcInputDir, '_close')); } catch { /* ignore */ }

  return new Promise((resolve) => {
    const container = spawnContainer(args);

    let stdout = '';
    let stderr = '';
    let outputReceived = false;

    container.stdout!.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Parse streaming output markers
      const startMarker = '---BIOCLAW_OUTPUT_START---';
      const endMarker = '---BIOCLAW_OUTPUT_END---';
      let startIdx: number;
      while ((startIdx = stdout.indexOf(startMarker)) !== -1) {
        const endIdx = stdout.indexOf(endMarker, startIdx);
        if (endIdx === -1) break;
        const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();
        stdout = stdout.slice(endIdx + endMarker.length);
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.error) {
            console.log(`\n[Error: ${parsed.error}]`);
          } else if (parsed.result) {
            const text = parsed.result.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            if (text) {
              console.log(`\n${ASSISTANT_NAME}: ${text}`);
            }
          }
        } catch { /* ignore parse errors */ }

        // Signal the container to exit after receiving output
        if (!outputReceived) {
          outputReceived = true;
          try {
            fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
          } catch { /* ignore */ }
        }
      }
    });

    container.stderr!.on('data', (data) => {
      stderr += data.toString();
    });

    container.stdin!.write(JSON.stringify(input));
    container.stdin!.end();

    const timeout = setTimeout(() => {
      console.log('\n[Timeout - stopping container]');
      container.kill();
    }, 300000); // 5 min timeout

    container.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.includes('BIOCLAW_OUTPUT')) {
        resolve(`[Error: container exited with code ${code}]`);
      } else {
        resolve('');
      }
    });
  });
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('  BioClaw - Biology Research Assistant');
  console.log(`  CLI Test Mode (${CONTAINER_RUNTIME} + Claude Agent)`);
  console.log('========================================');
  console.log('');
  console.log('Type a biology question or task. Type "exit" to quit.');
  console.log('Example: "Analyze DNA sequence ATGCGATCG and find ORFs"');
  console.log('');

  ensureDirs();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        console.log('Bye!');
        rl.close();
        process.exit(0);
      }

      console.log(`\n[Running in ${CONTAINER_RUNTIME} container...]`);
      await runAgent(trimmed);
      console.log('');
      askQuestion();
    });
  };

  askQuestion();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
