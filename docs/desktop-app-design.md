# BioClaw Desktop Application — Technical Design Document v3

> **Version:** 3.0  
> **Date:** 2026-04-16  
> **Author:** Claude / Runchuan  
> **Status:** Draft — revised after two rounds of code-level review  
> **Changelog:**  
> - v1 → v2: honest scope, Runtime Abstraction, MVP/Full split, threat model rewrite  
> - v2 → v3: symlink 方案改为 env-driven root path（不再保留零改 runner 幻想）；RuntimeContext 补 webAssetsDir/logoPath 资源路径 + HTTP 绑定打通；安全写死为 trusted local agent, no confirmation gate；P0 迁移清单补漏（channel.ts, control-plane.ts, task-scheduler.ts, group-queue.ts）+ main() guard

---

## 1. Executive Summary

将 BioClaw 打包为跨平台桌面应用（Windows `.exe`、macOS `.dmg`、Linux `.AppImage`）。

**v1 文档的核心问题（已修正）：**
- 改动量被严重低估（"51 行" → 实际 ~2000-3000 行）
- 状态目录迁移需要一个 Runtime Abstraction Layer
- agent-runner 有 29 处硬编码容器路径
- Docker 镜像的系统工具链（BLAST、samtools、PyMOL 等）无法用 pip 替代
- 安全模型需要诚实描述为"受信任本机代理"

**修正后的方案：**
1. 新增 **Phase 0: Runtime Abstraction** — 路径 + 资源 + HTTP 绑定全部从 `process.cwd()` 解耦
2. 拆分 **MVP** 和 **Full Parity** — MVP 只覆盖核心 skill（SEC、基本文件分析）
3. agent-runner **必须改代码**：引入 env-driven root path（v2 的 symlink 方案不可行，已放弃）
4. 安全模型写死：**trusted local agent, no confirmation gate**（和 Claude Code CLI 一致）

---

## 2. 现状分析：为什么不是"51 行改动"

### 2.1 状态目录硬编码（影响 12+ 个源文件）

`src/config.ts` 在模块加载时冻结路径：

```typescript
// src/config.ts:41-53
const PROJECT_ROOT = process.cwd();    // ← 模块加载时冻结
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
```

**直接依赖这些常量的文件：**

| 文件 | 依赖 | 用途 |
|------|------|------|
| `src/container-runner.ts` | `GROUPS_DIR` | 日志目录、workspace 路径 |
| `src/ipc.ts` | `DATA_DIR` | IPC 基础目录 |
| `src/db/connection.ts` | `STORE_DIR` | SQLite 数据库路径 |
| `src/db/migration.ts` | `DATA_DIR` | 数据迁移文件路径 |
| `src/notebook-export.ts` | `GROUPS_DIR` | Jupyter 导出路径 |
| `src/cli.ts` | `GROUPS_DIR`, `DATA_DIR` | CLI 模式路径 |
| `src/group-folder.ts` | `GROUPS_DIR` | workspace 文件夹管理 |
| `src/workspace.ts` | `GROUPS_DIR` | workspace 解析 |
| `src/session-manager.ts` | `DATA_DIR` | 会话目录 |
| `src/index.ts` | 间接依赖所有 | 主入口 |
| `src/dashboard/server.ts` | `GROUPS_DIR` | Dashboard API |
| `src/agent-trace.ts` | `DATA_DIR` | Trace 事件存储 |

**结论：** 不能直接改 `process.cwd()`，需要一个 Runtime Context 对象在启动时注入。

### 2.2 agent-runner 硬编码容器路径（29 处）

```
container/agent-runner/src/index.ts:     17 处
container/agent-runner/src/task-routing.ts: 10 处
container/agent-runner/src/ipc-mcp-stdio.ts: 2 处
```

关键硬编码：

```typescript
// index.ts
const SKILLS_ROOT = '/home/node/.claude/skills';
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';

// 多处直接使用 /workspace/group、/workspace/global、/workspace/extra
```

此外，**skill 的 SKILL.md 文件里也硬编码了容器路径**：

```markdown
# sec-report/SKILL.md
cd /home/node/.claude/skills/sec-report
python3 sec_pipeline.py --input ... --output ...
```

```markdown
# bio-tools/SKILL.md
Templates are in /home/node/.claude/skills/bio-tools/templates/
```

**结论：** 需要一个路径映射层，将容器路径翻译为本地路径，或在本地创建兼容的目录布局。

### 2.3 Docker 镜像的系统依赖（无法 pip 替代）

`container/Dockerfile` 安装的系统工具：

| 工具 | 大小 | 用途 | pip 可替代？ |
|------|------|------|-------------|
| Chromium | ~300 MB | agent-browser、网页截图 | 否（需系统包） |
| BLAST+ | ~100 MB | 序列比对 | 否 |
| samtools | ~20 MB | SAM/BAM 处理 | 否 |
| bedtools | ~30 MB | BED 文件操作 | 否 |
| bwa | ~10 MB | 短序列比对 | 否 |
| minimap2 | ~10 MB | 长序列比对 | 否 |
| PyMOL (headless) | ~200 MB | 蛋白结构渲染 | pip 可装开源版 |
| scanpy | pip | 单细胞分析 | 是 |
| RDKit | conda | 化学信息学 | conda 可装 |

**MVP 无法覆盖的 skill（依赖系统工具）：**
- `agent-browser` — 需要 Chromium
- `structural-biology` 部分功能 — 需要 PyMOL
- `sequence-analysis` 部分功能 — 需要 BLAST+
- `chip-seq`、`differential-expression` — 需要 samtools/bedtools

**MVP 可以覆盖的 skill：**
- `sec-report` — 只需 scipy, matplotlib, typst（已验证）
- `report-template` — 只需 typst
- `bio-tools` — 模板和参考信息
- `bio-figure-design` — matplotlib
- `sds-gel-review` — 只需 scipy, matplotlib
- 基本文件操作（Read/Write/Edit/Bash）

### 2.4 Electron 集成的实际障碍

1. **Node.js 运行时**：Electron 内置 Node.js，所以 `spawn('node', ...)` 可以用 Electron 自带的 `process.execPath`。但 agent-runner 是独立的 Node.js 项目，有自己的 `node_modules`（包括 Claude Agent SDK），需要打包进 resources。

2. **没有可复用的 start/stop API**：`src/index.ts` 的 `main()` 是一个顶层 async 函数，不返回控制句柄。需要重构为 `createApp(options): { start(), stop(), url }` 模式。

3. **tsconfig 限制**：`rootDir: 'src/'` 不允许编译 `electron/` 目录。需要分离为两个 tsconfig（`tsconfig.server.json` + `tsconfig.electron.json`）。

---

## 3. 修正后的架构

### 3.1 分层架构

```
┌─────────────────────────────────────────────────┐
│  Shell Layer (可替换)                             │
│  ├── Electron Desktop    (BioClaw.exe)           │
│  ├── Web Server          (npm run web, 现有)      │
│  └── CLI                 (npm run cli, 现有)      │
└─────────────────────┬───────────────────────────┘
                      │ createBioClawApp(options)
                      │ returns { start, stop, url }
┌─────────────────────▼───────────────────────────┐
│  Runtime Abstraction Layer (Phase 0 新增)         │
│                                                  │
│  RuntimeContext {                                 │
│    stateDir:     string   // DB, sessions        │
│    groupsDir:    string   // workspaces          │
│    dataDir:      string   // IPC, migrations     │
│    skillsDir:    string   // skill modules       │
│    pythonPath:   string   // python 可执行文件    │
│    agentRunnerPath: string                       │
│    apiKey:       string                          │
│    mode:         'server' | 'desktop'            │
│  }                                               │
│                                                  │
│  - 所有路径通过 RuntimeContext 注入               │
│  - config.ts 的常量改为 context 的 getter         │
│  - DB/IPC/workspace 通过 context 获取路径         │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│  Core Engine (现有代码，路径改为从 context 读)    │
│  ├── message-loop.ts                             │
│  ├── group-queue.ts                              │
│  ├── ipc.ts                                      │
│  ├── session-manager.ts                          │
│  ├── db/                                         │
│  └── channels/local-web/                         │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│  Runner Layer (可替换)                            │
│  ├── container-runner.ts  (Docker, 服务器用)      │
│  └── local-runner.ts      (子进程, 桌面用)        │
└─────────────────────┬───────────────────────────┘
                      │ stdin/stdout JSON markers
┌─────────────────────▼───────────────────────────┐
│  Agent Runner (子进程)                            │
│  ├── Claude Agent SDK query()                    │
│  ├── 路径映射: /workspace/* → context.paths.*    │
│  └── MCP Server (IPC tools)                      │
└──────────────────────────────────────────────────┘
```

### 3.2 Phase 0: Runtime Abstraction Layer

这是所有后续工作的前提。不做这一步，桌面版无法开始。

#### 3.2.1 新增 `src/runtime-context.ts`

```typescript
// src/runtime-context.ts

import path from 'path';

export interface RuntimeOptions {
  /** 'server' = Docker containers (current), 'desktop' = local subprocess */
  mode: 'server' | 'desktop';

  // ── Mutable state directories ──
  /** Root directory for workspaces/groups */
  groupsDir: string;
  /** Root directory for IPC, sessions, migrations */
  dataDir: string;
  /** Root directory for DB files */
  stateDir: string;

  // ── Immutable resource directories ──
  /** Directory containing skill modules */
  skillsDir: string;
  /** Directory containing web UI assets (index.html, app.js, style.css) */
  webAssetsDir: string;
  /** Path to favicon/logo file */
  logoPath: string;
  /** Directory containing vendor scripts (marked.umd.js, purify.min.js) */
  vendorScriptsDir?: string;

  // ── Executables ──
  /** Python executable path (desktop only) */
  pythonPath?: string;
  /** Compiled agent-runner entry point */
  agentRunnerPath?: string;

  // ── Credentials ──
  /** Anthropic API key (desktop only; server reads from env/credential-proxy) */
  apiKey?: string;

  // ── HTTP binding ──
  /** HTTP server port (0 = auto-assign) */
  port?: number;
  /** HTTP server host */
  host?: string;
}

export class RuntimeContext {
  readonly mode: 'server' | 'desktop';
  readonly groupsDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly skillsDir: string;
  readonly pythonPath: string;
  readonly agentRunnerPath: string;
  readonly apiKey: string;
  readonly port: number;
  readonly host: string;

  // ── Immutable resources ──
  readonly webAssetsDir: string;
  readonly logoPath: string;
  readonly vendorScriptsDir: string;

  constructor(opts: RuntimeOptions) {
    this.mode = opts.mode;
    this.groupsDir = path.resolve(opts.groupsDir);
    this.dataDir = path.resolve(opts.dataDir);
    this.stateDir = path.resolve(opts.stateDir);
    this.skillsDir = path.resolve(opts.skillsDir);
    this.webAssetsDir = path.resolve(opts.webAssetsDir);
    this.logoPath = path.resolve(opts.logoPath);
    this.vendorScriptsDir = opts.vendorScriptsDir
      ? path.resolve(opts.vendorScriptsDir)
      : path.join(this.webAssetsDir, '..', 'vendor');
    this.pythonPath = opts.pythonPath || 'python3';
    this.agentRunnerPath = opts.agentRunnerPath || '';
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.port = opts.port || 3000;
    this.host = opts.host || 'localhost';
  }

  /** Database file path */
  get dbPath(): string {
    return path.join(this.stateDir, 'messages.db');
  }

  /** IPC base directory */
  get ipcDir(): string {
    return path.join(this.dataDir, 'ipc');
  }

  /** Sessions directory */
  get sessionsDir(): string {
    return path.join(this.dataDir, 'sessions');
  }

  /** Per-agent IPC directory */
  ipcDirForAgent(agentId: string): string {
    return path.join(this.ipcDir, agentId);
  }

  /** Per-agent session directory */
  sessionDirForAgent(agentId: string): string {
    return path.join(this.sessionsDir, agentId, '.claude');
  }

  /** Per-agent skills directory */
  skillsDirForAgent(agentId: string): string {
    return path.join(this.sessionsDir, agentId, '.claude', 'skills');
  }

  /** Workspace directory for a group */
  groupDir(folder: string): string {
    return path.join(this.groupsDir, folder);
  }

  /** Logs directory for a group */
  logsDir(folder: string): string {
    return path.join(this.groupsDir, folder, 'logs');
  }

  /** Whether running in desktop mode */
  get isDesktop(): boolean {
    return this.mode === 'desktop';
  }

  /**
   * Create context for current server deployment mode
   * (backward-compatible with existing process.cwd() behavior)
   */
  static forServer(): RuntimeContext {
    const root = process.cwd();
    return new RuntimeContext({
      mode: 'server',
      groupsDir: path.join(root, 'groups'),
      dataDir: path.join(root, 'data'),
      stateDir: path.join(root, 'store'),
      skillsDir: path.join(root, 'container', 'skills'),
      webAssetsDir: path.join(root, 'src', 'channels', 'local-web', 'assets'),
      logoPath: path.join(root, 'bioclaw_logo.jpg'),
    });
  }

  /**
   * Create context for desktop mode.
   * resourcesDir = process.resourcesPath in Electron (extraResources target)
   */
  static forDesktop(userDataDir: string, resourcesDir: string): RuntimeContext {
    return new RuntimeContext({
      mode: 'desktop',
      groupsDir: path.join(userDataDir, 'workspaces'),
      dataDir: path.join(userDataDir, 'data'),
      stateDir: path.join(userDataDir, 'store'),
      skillsDir: path.join(resourcesDir, 'skills'),
      webAssetsDir: path.join(resourcesDir, 'web-assets'),
      logoPath: path.join(resourcesDir, 'web-assets', 'bioclaw_logo.jpg'),
      vendorScriptsDir: path.join(resourcesDir, 'web-assets', 'vendor'),
      agentRunnerPath: path.join(resourcesDir, 'agent-runner', 'dist', 'index.js'),
      port: 0,  // auto-assign
      host: '127.0.0.1',
    });
  }
}

// ── Global singleton (set once at startup) ──

let _ctx: RuntimeContext | null = null;

export function initRuntime(ctx: RuntimeContext): void {
  if (_ctx) throw new Error('Runtime already initialized');
  _ctx = ctx;
}

export function getRuntime(): RuntimeContext {
  if (!_ctx) throw new Error('Runtime not initialized — call initRuntime() first');
  return _ctx;
}
```

#### 3.2.2 迁移 `src/config.ts`

```typescript
// src/config.ts — 改后

import { getRuntime } from './runtime-context.js';

// 静态配置（不依赖路径，保持原样）
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Bioclaw';
export const POLL_INTERVAL = 2000;
// ... 其他环境变量配置不变 ...

// 路径配置：改为运行时 getter
// 旧：export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
// 新：
export function getGroupsDir(): string { return getRuntime().groupsDir; }
export function getDataDir(): string { return getRuntime().dataDir; }
export function getStoreDir(): string { return getRuntime().stateDir; }

// 向后兼容：对于已有代码中大量使用 GROUPS_DIR 的地方，
// 可以先保留常量但标记 deprecated，逐步迁移：
// @deprecated — use getRuntime().groupsDir
export let GROUPS_DIR = '';
export let DATA_DIR = '';
export let STORE_DIR = '';

export function _freezeLegacyPaths(): void {
  const ctx = getRuntime();
  GROUPS_DIR = ctx.groupsDir;
  DATA_DIR = ctx.dataDir;
  STORE_DIR = ctx.stateDir;
}
```

#### 3.2.3 迁移 `src/index.ts`

```typescript
// src/index.ts — 改后

import { RuntimeContext, initRuntime } from './runtime-context.js';
import { _freezeLegacyPaths } from './config.js';

export interface BioclawApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

export async function createBioClawApp(ctx: RuntimeContext): Promise<BioclawApp> {
  // 1. 初始化运行时
  initRuntime(ctx);
  _freezeLegacyPaths();  // 向后兼容

  // 2. 确保目录存在
  fs.mkdirSync(ctx.groupsDir, { recursive: true });
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  fs.mkdirSync(ctx.stateDir, { recursive: true });

  // 3. 初始化 DB
  const db = initDatabase(ctx.dbPath);

  // 4. 选择 runner
  const runner = ctx.isDesktop
    ? createLocalRunner(ctx)
    : createContainerRunner(ctx);

  // 5. 启动所有子系统
  // ... (现有 main() 的逻辑，但使用 ctx 替代全局常量) ...

  const url = `http://${ctx.host}:${ctx.port}`;

  return {
    async start() { /* 启动 HTTP server, message loop, IPC watcher */ },
    async stop()  { /* 停止所有 */ },
    url,
  };
}

// 向后兼容：现有的 npm run web / npm run dev 入口
async function main() {
  const ctx = RuntimeContext.forServer();
  const app = await createBioClawApp(ctx);
  await app.start();
}
main();
```

#### 3.2.4 改动量（诚实估算 — v3 补漏）

v2 漏掉了 `channels/local-web/channel.ts`、`control-plane.ts`、`task-scheduler.ts`、`group-queue.ts`。完整清单：

| 文件 | 依赖的常量 | 改动量 |
|------|-----------|--------|
| `src/runtime-context.ts` | 新增 | ~150 行（含资源路径） |
| `src/config.ts` | `GROUPS_DIR`, `DATA_DIR`, `STORE_DIR` | ~60 改动 |
| `src/index.ts` | 全部（重构为 createApp + main() guard） | ~200 改动 |
| `src/channels/local-web/channel.ts` | `GROUPS_DIR`(6处), `LOCAL_WEB_HOST/PORT`, `ASSETS_DIR`(硬编码), `favicon`(硬编码) | ~40 改动 |
| `src/control-plane.ts` | `GROUPS_DIR`(4处) | ~20 改动 |
| `src/container-runner.ts` | `GROUPS_DIR` | ~30 改动 |
| `src/ipc.ts` | `DATA_DIR` | ~15 改动 |
| `src/task-scheduler.ts` | `DATA_DIR`, `GROUPS_DIR` | ~15 改动 |
| `src/group-queue.ts` | `DATA_DIR` (间接) | ~10 改动 |
| `src/db/connection.ts` | `STORE_DIR` | ~10 改动 |
| `src/db/migration.ts` | `DATA_DIR` | ~5 改动 |
| `src/notebook-export.ts` | `GROUPS_DIR` | ~10 改动 |
| `src/cli.ts` | `GROUPS_DIR`, `DATA_DIR`, `process.cwd()` | ~30 改动 |
| `src/group-folder.ts` | `GROUPS_DIR` | ~10 改动 |
| `src/workspace.ts` | `GROUPS_DIR` | ~10 改动 |
| `src/session-manager.ts` | `DATA_DIR` | ~10 改动 |
| `src/agent-trace.ts` | `DATA_DIR` | ~5 改动 |
| `src/dashboard/server.ts` | `GROUPS_DIR` | ~10 改动 |
| **Phase 0 总计** | | **~640 行** |

#### 3.2.5 `src/index.ts` main() guard

`createBioClawApp()` 导出后，Electron 会 `import` 它。必须防止 import 时自动执行 `main()`：

```typescript
// src/index.ts 末尾

// 仅在直接运行时启动（不在 import/require 时）
// Node.js ESM: import.meta.url === 入口文件
// Node.js CJS: require.main === module
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const ctx = RuntimeContext.forServer();
  const app = await createBioClawApp(ctx);
  await app.start();
}
```

#### 3.2.6 `channels/local-web/channel.ts` 资源路径迁移

当前硬编码：

```typescript
// 现在：
private static readonly ASSETS_DIR = path.join('src', 'channels', 'local-web', 'assets');
// favicon:
this.serveFile(path.resolve('bioclaw_logo.jpg'), 'image/jpeg', res, 604800);
// listen:
this.server!.listen(LOCAL_WEB_PORT, LOCAL_WEB_HOST, () => { ... });
```

改为从 RuntimeContext 读：

```typescript
// 改后：
constructor(private ctx: RuntimeContext) { }

private get assetsDir() { return this.ctx.webAssetsDir; }

// favicon:
this.serveFile(this.ctx.logoPath, 'image/jpeg', res, 604800);

// listen — 端口从 ctx 读，支持 0（auto-assign）：
this.server!.listen(this.ctx.port, this.ctx.host, () => {
  const addr = this.server!.address();
  const actualPort = typeof addr === 'object' ? addr!.port : this.ctx.port;
  // 回写 actualPort 供 Electron 使用
});
```

### 3.3 agent-runner 路径改造（必须改代码）

#### v2 symlink 方案为什么不可行

v2 提议在本地创建目录树 `<compatRoot>/workspace/group` 来模拟容器布局。**这行不通**：

1. agent-runner 用的是**绝对路径** `/workspace/group`、`/workspace/ipc`、`/home/node/.claude/skills`，不是相对路径。设 `cwd` 到 compatRoot 不会让 `/workspace/group` 指向那里。
2. `cpSync` fallback 会复制文件而非共享，IPC 的"宿主机写文件 → 子进程读"语义直接断掉。
3. Windows 上 junction 只支持目录，且无法映射到 `/workspace` 这样的 Unix 绝对路径。

#### 正确方案：env-driven root path

给 agent-runner 引入 4 个环境变量，每个对应一个硬编码根路径：

```typescript
// container/agent-runner/src/index.ts — 改后

// 旧：
// const IPC_INPUT_DIR = '/workspace/ipc/input';
// const IPC_DIR = '/workspace/ipc';
// const WORKSPACE_GROUP_ROOT = '/workspace/group';
// const SKILLS_ROOT = '/home/node/.claude/skills';

// 新：
const WORKSPACE_ROOT = process.env.BIOCLAW_WORKSPACE_ROOT || '/workspace';
const IPC_DIR = path.join(
  process.env.BIOCLAW_IPC_ROOT || path.join(WORKSPACE_ROOT, 'ipc')
);
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_FILES_DIR = path.join(IPC_DIR, 'files');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

const WORKSPACE_GROUP_ROOT = process.env.BIOCLAW_GROUP_ROOT
  || path.join(WORKSPACE_ROOT, 'group');
const WORKSPACE_GLOBAL_ROOT = process.env.BIOCLAW_GLOBAL_ROOT
  || path.join(WORKSPACE_ROOT, 'global');
const SKILLS_ROOT = process.env.BIOCLAW_SKILLS_ROOT
  || '/home/node/.claude/skills';
```

**同样需要改的文件：**

| 文件 | 硬编码 | 改动 |
|------|--------|------|
| `agent-runner/src/index.ts` | 17 处 `/workspace/*`, `/home/node/.claude` | 改为上述 env 变量 |
| `agent-runner/src/task-routing.ts` | 10 处 | 同样读 env |
| `agent-runner/src/ipc-mcp-stdio.ts` | 2 处 | 同样读 env |
| **总计** | **29 处** | **~60 行改动** |

**Skill SKILL.md 中的路径**（如 `cd /home/node/.claude/skills/sec-report`）：这些是给 Claude 模型看的指令文本，模型在桌面模式下会根据实际 `cwd` 和环境自动调整命令。但为了安全，在 agent-runner 的 bio system prompt 里注入实际路径：

```typescript
// agent-runner 启动时注入
const bioPromptOverride = `Skills are located at: ${SKILLS_ROOT}\n`
  + `Working directory: ${WORKSPACE_GROUP_ROOT}\n`;
```

#### local-runner 传递环境变量

```typescript
// src/local-runner.ts

const child = spawn(process.execPath, [agentRunnerPath], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BIOCLAW_WORKSPACE_ROOT: ctx.groupDir(input.groupFolder),
    BIOCLAW_IPC_ROOT: ctx.ipcDirForAgent(input.agentId),
    BIOCLAW_GROUP_ROOT: ctx.groupDir(input.groupFolder),
    BIOCLAW_GLOBAL_ROOT: path.join(ctx.groupsDir, 'global'),
    BIOCLAW_SKILLS_ROOT: ctx.skillsDirForAgent(input.agentId),
    ANTHROPIC_API_KEY: ctx.apiKey,
    PATH: `${path.dirname(ctx.pythonPath)}:${process.env.PATH}`,
  },
  cwd: ctx.groupDir(input.groupFolder),
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**服务器模式不受影响**：环境变量不设时 fallback 到原硬编码值，Docker 容器内行为不变。

### 3.4 功能分级：MVP vs Full Parity

#### MVP（桌面版 v1.0）

| 功能 | 依赖 | 状态 |
|------|------|------|
| 对话 + 多线程 | Node.js + SQLite | 可用 |
| 文件上传 + 工作区 | 本地文件系统 | 可用 |
| SEC 分析报告 | scipy, matplotlib, typst | 可用 |
| SDS-PAGE 分析 | scipy, matplotlib | 可用 |
| Typst 报告模板 | typst pip 包 | 可用 |
| 基本文件操作 | Bash, Read, Write, Edit | 可用 |
| Python 脚本执行 | 本地 Python | 可用 |
| Markdown/代码生成 | Claude Agent SDK | 可用 |
| 实验追踪 (Trace) | 本地 DB + SSE | 可用 |
| 设置 (语言/主题) | 本地 localStorage | 可用 |

#### Full Parity（桌面版 v2.0+）

| 功能 | 缺少的依赖 | 补充方案 |
|------|-----------|---------|
| 网页截图/爬取 | Chromium | 用户安装 Chrome，检测系统 Chrome 路径 |
| 序列比对 | BLAST+ | conda install blast |
| BAM/BED 处理 | samtools, bedtools | conda install samtools bedtools |
| 蛋白结构渲染 | PyMOL | pip install pymol-open-source |
| 单细胞分析 | scanpy | pip install scanpy |
| 化学信息学 | RDKit | conda install rdkit |

**Full Parity 的安装方式：** 在设置页面提供"扩展工具包"按钮，按需下载安装（conda install）。

### 3.5 安全：诚实的 Threat Model

#### 桌面版定位：受信任本机代理

```
┌─────────────────────────────────────────────────┐
│  THREAT MODEL: Trusted Local Agent               │
│                                                  │
│  BioClaw 桌面版运行在用户自己的电脑上，              │
│  拥有与用户相同的文件系统和网络权限。                │
│                                                  │
│  这 **不是** 沙箱隔离环境。                        │
│  这与 Claude Code CLI 的安全模型一致：              │
│  用户信任 agent，agent 在用户权限下执行。           │
└─────────────────────────────────────────────────┘
```

#### 对比

| 方面 | 服务器版 (Docker) | 桌面版 (Local) | Claude Code CLI |
|------|------------------|---------------|-----------------|
| 文件系统 | 容器隔离 | **用户权限** | 用户权限 |
| 网络 | 容器网络 | **主机网络** | 主机网络 |
| 进程 | 容器内 | **本地子进程** | 本地进程 |
| API Key | 容器环境变量 | OS 密钥链加密 | 环境变量 |
| 适用场景 | 多用户、不信任 agent | 单用户、信任 agent | 单用户、信任 agent |

#### 安全定位：无二次确认，等同受信任本机代理

当前 agent-runner 使用 `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`。桌面版**保持此行为不变**。

这意味着：
- Agent 执行 Bash 命令、读写文件**不会弹确认窗口**
- 和 Claude Code CLI 的默认行为一致
- 用户对 agent 的操作承担完全责任

**不做以下事情（v2 文档中错误承诺的）：**
- ~~高风险操作用户确认~~ → 不做，当前 runner 就是 bypass 模式
- ~~限制文件系统访问~~ → 不做，agent 有完整用户权限
- ~~仅连 Anthropic~~ → 不做，WebFetch 可访问任意 URL

**实际做的缓解（最小集）：**

| 风险 | 实际缓解 |
|------|---------|
| API Key 泄露到 Bash 子进程 | PreToolUse hook 在 Bash 前 `unset`（现有机制，保留） |
| API Key 磁盘存储 | Electron `safeStorage`；**不可用时拒绝存储，要求用户每次输入** |
| HTTP 暴露到局域网 | 绑定 `127.0.0.1`（非 `0.0.0.0`） |
| 误操作风险 | 首次启动提示："BioClaw 以您的身份运行，可访问所有文件" |

**未来可选增强（不在 MVP 范围内）：**
- 桌面版可切换为非 bypass 权限模式 + 确认 UI
- 工作区白名单（限制 cwd 到指定目录）
- 命令审计日志

### 3.6 Python 环境管理（修正版）

v1 的问题：下载 latest miniconda 无版本锁定、无完整性校验。

修正方案：

```typescript
// 锁定版本 + SHA256 校验
const MINICONDA_RELEASES: Record<string, { url: string; sha256: string }> = {
  'win32-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-Windows-x86_64.exe',
    sha256: 'a]固定的hash值',
  },
  'darwin-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-MacOSX-x86_64.sh',
    sha256: '固定的hash值',
  },
  'darwin-arm64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-MacOSX-arm64.sh',
    sha256: '固定的hash值',
  },
  'linux-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-Linux-x86_64.sh',
    sha256: '固定的hash值',
  },
};

// pip 包也锁版本
const PYTHON_PACKAGES = [
  'numpy==1.26.4',
  'scipy==1.14.1',
  'pandas==2.2.3',
  'matplotlib==3.9.3',
  'seaborn==0.13.2',
  'biopython==1.84',
  'typst==0.14.8',
  'fpdf2==2.8.2',
  'openpyxl==3.1.5',
  'scikit-learn==1.5.2',
];

// 下载后校验
async function verifyChecksum(filePath: string, expectedSha256: string): Promise<boolean> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex') === expectedSha256;
}
```

### 3.7 设置向导流程（修正版）

v1 的 bug：保存 API Key 时就设 `configured=true`，Python 安装失败后下次启动跳过设置。

修正：

```typescript
// 设置状态机
interface SetupState {
  apiKeySet: boolean;
  pythonInstalled: boolean;
  // configured = apiKeySet && pythonInstalled
}

function isFullyConfigured(state: SetupState): boolean {
  return state.apiKeySet && state.pythonInstalled;
}

// 首次启动检查
if (!isFullyConfigured(config.getSetupState())) {
  showSetupWizard(config.getSetupState()); // 从上次失败的步骤继续
}
```

### 3.8 Electron Node.js 问题

用户机器没有 Node.js → 用 Electron 自带的 Node.js 运行 agent-runner：

```typescript
// 使用 Electron 内置的 Node.js 来运行 agent-runner
const child = spawn(process.execPath, [  // process.execPath = Electron 的 node
  '--no-warnings',
  agentRunnerPath,
], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',  // 关键：让 Electron 以纯 Node.js 模式运行
  },
  cwd: workspaceDir,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

`ELECTRON_RUN_AS_NODE=1` 让 Electron 可执行文件以纯 Node.js 模式运行子进程，无需用户安装 Node.js。

### 3.9 tsconfig 分离

```json
// tsconfig.server.json（服务器部署，现有）
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"]
}

// tsconfig.electron.json（桌面版，新增）
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "electron-dist" },
  "include": ["electron/**/*", "src/**/*"]
}

// tsconfig.base.json（共享配置）
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

---

## 4. 修正后的改动量估算

| Phase | 文件 | 新增行 | 改动行 | 说明 |
|-------|------|--------|--------|------|
| **P0: Runtime Abstraction** | | | | |
| | `src/runtime-context.ts` | 150 | — | 新增（含资源路径） |
| | `src/config.ts` | — | 60 | 路径改为 getter |
| | `src/index.ts` | 80 | 200 | createApp + main() guard |
| | `src/channels/local-web/channel.ts` | — | 40 | 资源路径 + HTTP 绑定 |
| | `src/control-plane.ts` | — | 20 | GROUPS_DIR → ctx |
| | `src/task-scheduler.ts` | — | 15 | 同上 |
| | `src/group-queue.ts` | — | 10 | 同上 |
| | 其他 10 个依赖文件 | — | 120 | 同上 |
| | **小计** | **230** | **465** | |
| **P1: Local Runner + agent-runner env** | | | | |
| | `src/local-runner.ts` | 250 | — | 新增 |
| | `src/container-runtime.ts` | — | 20 | 加 local 选项 |
| | `agent-runner/src/index.ts` | — | 40 | 29处硬编码 → env var |
| | `agent-runner/src/task-routing.ts` | — | 15 | 同上 |
| | `agent-runner/src/ipc-mcp-stdio.ts` | — | 5 | 同上 |
| | **小计** | **250** | **80** | |
| **P2: Electron Shell** | | | | |
| | `electron/main.ts` | 250 | — | 新增 |
| | `electron/preload.ts` | 30 | — | 新增 |
| | `electron/setup-wizard.html` | 200 | — | 新增 |
| | `electron/python-manager.ts` | 220 | — | 新增，含版本锁定+校验 |
| | `electron/config-store.ts` | 100 | — | 新增，无明文降级 |
| | `electron/auto-updater.ts` | 60 | — | 新增 |
| | `electron-builder.yml` | 80 | — | 新增 |
| | `tsconfig.base.json` | 15 | — | 新增 |
| | `tsconfig.electron.json` | 10 | — | 新增 |
| | `package.json` | — | 20 | 加依赖和脚本 |
| | **小计** | **965** | **20** | |
| **P3: agent-runner 兼容** | | | | |
| | agent-runner 环境变量化 | — | 40 | SKILLS_ROOT 等 |
| | **或** 路径映射 helper（零改 runner） | 80 | — | local-runner 中 |
| | **小计** | **80** | **40** | |
| **总计** | | **~1525** | **~440** | **~2000 行变更** |

对比 v1 文档声称的"~1020 行新代码 + 51 行改动"，实际规模约 **2.5x**（~2500 行变更）。

---

## 5. 修正后的里程碑

| Phase | 内容 | 前置条件 | 产出 |
|-------|------|---------|------|
| **P0** | Runtime Abstraction Layer | 无 | `createBioClawApp(ctx)` API，所有路径解耦 |
| **P1** | Local Runner + 路径映射 | P0 | 本地子进程可运行 agent |
| **P2** | Electron Shell + Setup Wizard | P0, P1 | 桌面窗口可运行 |
| **P3** | Python Manager + 版本锁定 | P2 | 首次设置自动部署 Python |
| **P4** | Packaging + Testing | P0-P3 | `.exe` / `.dmg` / `.AppImage` |
| **P5** | MVP 验证 | P4 | SEC 分析端到端通过 |
| **P6** | Full Parity 扩展包 | P5 | 系统工具按需安装 |

---

## 6. 遗留问题（需进一步决策）

| 问题 | 选项 | 推荐 |
|------|------|------|
| macOS 代码签名 | 自签名 / Apple Developer ($99/yr) | 先自签名，用户手动允许 |
| Windows SmartScreen | 无签名有警告 / EV 证书 ($200+/yr) | 先无签名，README 说明 |
| 自动更新服务器 | GitHub Releases / 自建 | GitHub Releases |
| 离线安装模式 | 预打包 Python 环境 / 仅在线 | 在线为主，提供离线包作为可选 |
| Docker 模式保留 | 桌面版可选 Docker / 仅 local | 高级设置中保留 Docker 选项 |

---

## 7. 审阅对照表

### Round 1 (v1 → v2)

| 发现 | 级别 | v2 处置 |
|------|------|---------|
| 状态目录迁移被低估 | High | P0 RuntimeContext |
| agent-runner 不是 1 行 | High | 路径映射 helper（零改 runner） |
| 功能等价性不一致 | High | MVP/Full 分级 |
| 安全描述过度乐观 | High | Threat model 改为"受信任本机代理" |
| Electron 集成不落地 | High | ELECTRON_RUN_AS_NODE、tsconfig 分离、createApp API |
| safeStorage 降级明文 | Medium | 不降级，提示用户设置密钥链 |
| Python 版本未锁定 | Medium | 锁定版本 + SHA256 校验 |
| 设置向导状态 bug | Medium | 分离 apiKeySet / pythonInstalled 状态 |

### Round 2 (v2 → v3)

| 发现 | 级别 | v3 处置 |
|------|------|---------|
| symlink 方案不可行（绝对路径） | High | **放弃 symlink，改为 env-driven root path（4 个环境变量，29 处改动）** |
| RuntimeContext 缺资源路径 + HTTP 绑定 | High | **补 webAssetsDir/logoPath/vendorScriptsDir；channel.ts 从 ctx 读端口** |
| 安全写"用户确认"但 runner 是 bypass | Medium-High | **写死：trusted local agent, no confirmation gate** |
| P0 清单漏文件 + 缺 main() guard | Medium | **补 channel.ts/control-plane.ts/task-scheduler.ts/group-queue.ts；加 isDirectRun guard** |
