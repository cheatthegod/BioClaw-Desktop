# BioClaw 桌面端

> [chat.bioclaw.tech](https://chat.bioclaw.tech) 的原生桌面壳 —— 基于 Tauri 2、React 19、Vite 构建,服务于 BioClaw 生物医学研究 Agent。

[![CI](https://img.shields.io/badge/CI-待接入-lightgrey.svg)](#) [![Release](https://img.shields.io/badge/release-0.1.0--alpha-blue.svg)](#) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

BioClaw 桌面端是 BioClaw 生物医学研究 Agent 的官方开源桌面客户端。**第一阶段**为薄客户端:Tauri 负责开一扇原生窗口,自管标题栏、系统托盘、设置抽屉,以及文件对话框、原生通知、自动更新等系统交互;窗口里加载的是 `chat.bioclaw.tech`,聊天界面本体仍在线上服务里。**第二、三阶段**会陆续引入本地 Agent 运行时和 MCP 原生工具集成,详见下文[路线图](#路线图)。

当前仓库就是这套薄客户端骨架的首个版本(`0.1.0`),已经能打开窗口、加载线上聊天页,后续每一项原生能力都有挂载点。

---

## 功能

当前骨架真正包含的能力(没有的不要写):

- **原生桌面窗口** —— 自定义 Overlay 标题栏(隐藏系统装饰),默认 1280×820,通过 `tauri-plugin-window-state` 在多次启动间记忆窗口位置和尺寸。
- **薄客户端模式** —— 在 WebView 中加载 `https://chat.bioclaw.tech`,把它当作聊天主体;桌面壳只负责外围交互。
- **系统托盘** —— macOS 模板渲染的托盘图标,支持显示/隐藏/退出,实现在 `src-tauri/src/tray.rs`。
- **自动更新接线** —— Tauri Updater 插件指向 `https://chat.bioclaw.tech/desktop/updates/{{target}}/{{arch}}/{{current_version}}`。Debug 构建下禁用;minisign 公钥目前是占位符,**正式发版前必须替换**。
- **严格的默认 CSP** —— `connect-src` / `frame-src` 仅放行 `chat.bioclaw.tech` 及其子域,其它一律拦截。
- **跨平台打包** —— `npm run tauri:build:mac|win|linux` 分别输出 dmg、nsis + msi、AppImage + deb;`nsis` 安装器已预接简体中文。

明确**不包含**的能力:语音输入、多人实时协作、本地 LLM 推理、MCP 服务、离线聊天历史、任何自定义聊天 UI —— 这些放到后续阶段。

---

## 用户快速开始

正式安装包会在第一次签名构建落地后发布到 GitHub Releases。

> 下载链接(占位):https://github.com/bioclaw/bioclaw-desktop/releases/latest

v0.1 系列的系统支持矩阵如下:

| 平台    | 最低版本                     | 安装包格式           | 自动更新      |
| ------- | ---------------------------- | -------------------- | ------------- |
| macOS   | 11 Big Sur(通用二进制)     | `.dmg`               | 支持          |
| Windows | 10 1809(x64)                | `.msi` / `.exe`      | 支持          |
| Linux   | webkit2gtk 4.1(Ubuntu 22+)  | `.AppImage` / `.deb` | AppImage 支持,deb 手动升级 |

桌面端访问的是 `chat.bioclaw.tech`,所以使用之前请先有 BioClaw 账号;在 WebView 里登录,流程跟浏览器一样。

---

## 开发者快速开始

### 前置条件

- **Node.js 20+**(`package.json` 的 `engines` 强制要求,推荐 22 LTS)
- **npm 10+**(随 Node 20 自带)
- **Rust stable**(用 `rustup` 装,Cargo edition 2021,`rust-version = 1.77` 是底线)
- 各平台的系统依赖 —— 完整 apt / brew / winget 命令见 [`docs/BUILD.md`](./docs/BUILD.md)

### 安装

```bash
git clone https://github.com/bioclaw/bioclaw-desktop.git
cd bioclaw-desktop
npm install
```

`src-tauri` 第一次 `cargo` 构建会拉几分钟 —— Tauri 2 加上 11 个启用的插件,依赖树确实大。后续都是增量构建,会快很多。

### 调试运行

```bash
npm run tauri:dev
```

会先在 `http://localhost:1420` 起 Vite,再启动 Tauri Debug 壳并指向它。`src/**` 的改动热更;`src-tauri/**` 的改动会重启 Rust 进程。Debug 构建里 Updater 插件被有意关掉(见 `src-tauri/src/lib.rs`),避免每次重载都打不通更新接口。

### 构建

```bash
npm run tauri:build          # 当前主机原生 target
npm run tauri:build:mac      # Apple darwin 通用二进制
npm run tauri:build:win      # x86_64-pc-windows-msvc
npm run tauri:build:linux    # x86_64-unknown-linux-gnu
```

产物落在 `src-tauri/target/<target>/release/bundle/`。`tauri.conf.json` 里的签名身份字段都是 `null` —— 正式签名密钥应该放在 CI Secrets 里,不要进仓库。

其它常用脚本:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint,零警告
npm run format       # prettier 写盘(顺带提醒跑 cargo fmt)
npm run clean        # 清掉 dist、src-tauri/target、vite 缓存
```

---

## 架构总览

```
+---------------------------------------------------------------+
|                     BioClaw Desktop 进程                       |
|                                                               |
|  +---------------------+        +---------------------------+ |
|  | Tauri 主进程 (Rust) |  IPC   |  WebView(系统 webkit)    | |
|  |  - 托盘、更新器     |<------>|  React 19 + Vite 外壳     | |
|  |  - 11 个插件        |        |   - TitleBar              | |
|  |  - 类型化 commands  |        |   - SettingsDrawer        | |
|  |  - capabilities     |        |   - ConnectionGuard       | |
|  +---------------------+        +-------------+-------------+ |
|                                               |               |
|                                               | <iframe>      |
|                                               v               |
|                            +----------------------------------+
|                            | https://chat.bioclaw.tech (远端) |
|                            +----------------------------------+
+---------------------------------------------------------------+
```

- **Tauri 主进程(Rust)** —— `src-tauri/src/lib.rs` 启动运行时、注册插件、暴露 4 个 invoke handler(`app_version`、`reveal_in_finder`、`open_external_url`、`quit_app`)、装托盘。
- **React 外壳** —— `src/App.tsx` 是一层很薄的 Zustand 视图。它渲染自定义标题栏、设置抽屉,以及一个指向 `chat.bioclaw.tech` 的 iframe。状态在 `src/lib/store.ts`,刻意保持精简 —— 聊天状态应属于远端应用本身。
- **远端聊天服务** —— 真正的 LLM 编排、RAG、工具调用都在 BioClaw SaaS 那边;桌面壳此时此刻不接触原始模型流量。

CSP 写在 `src-tauri/tauri.conf.json`,只放行 `chat.bioclaw.tech` 及其子域到 `connect-src` / `frame-src`,其余锁死在 `'self'`(`'unsafe-eval'` 是 Vite 打的 React 必需)。完整分层图、决策记录见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),威胁模型见 [`docs/SECURITY.md`](./docs/SECURITY.md)。

---

## 路线图

桌面端分三个阶段推进,每个阶段都能独立发版。

**第一阶段 —— 薄客户端(当前,v0.1.x)。**
原生窗口 + 托盘 + 自动更新,壳里装 `chat.bioclaw.tech`。目标是用户能拿到一个真正的桌面安装(Dock 图标、开始菜单快捷方式、原生通知、OS 级窗口状态),而不去 fork 任何聊天 UI。当前仓库就在这一阶段。

**第二阶段 —— 本地 Agent Sidecar(v0.2.x)。**
通过 Tauri Sidecar 内嵌一个 Agent Runner。`useAppStore` 里已经预留的 `mode: 'local' | 'remote'` 开关会把 WebView 在 `chat.bioclaw.tech` 和 Sidecar 本地的 `http://127.0.0.1:3000` 之间切换。Sidecar 复用 BioClaw-SaaS 的 Agent 内核,但跑在本机,API key 用 OS 钥匙串保管。

**第三阶段 —— MCP 原生工具集成(v0.3.x)。**
通过 [Model Context Protocol](https://modelcontextprotocol.io/) 把桌面侧能力 —— 文件系统、Shell、浏览器自动化、实验记录摄取 —— 暴露给 BioClaw Agent。`src-tauri/src/commands.rs` 里的 Tauri command 面就是 MCP server 接触用户数据的边界,受 capability 与会话级用户授权双重控制。

更细的拆分参见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

## 许可证

MIT 许可,完整文本见 [`LICENSE`](./LICENSE)。

Tauri 是 Apache-2.0 / MIT 双许可;React 是 MIT;捆绑的 npm 和 Cargo 依赖均为 MIT、Apache-2.0、BSD、ISC 或兼容许可。每次发版前请跑一遍 `cargo about` 与 `npm-license-checker` 自查。

---

## 致谢

桌面端能这么快走到能跑的状态,要谢这些先趟过路的项目。本仓库没有 vendoring 它们任何代码,纯粹是设计层面的启发:

- [**Tauri**](https://tauri.app/) —— 让我们能在合理的二进制体积下做到这件事的运行时。
- [**opencode**](https://github.com/sst/opencode) —— 演示了 TUI 优先的 Agent CLI 怎样干净地包成桌面壳。
- [**Jan**](https://github.com/menloresearch/jan) —— 一份 MIT 许可的本地 LLM 桌面参考架构。
- [**Goose**](https://github.com/block/goose) —— 验证了 MCP 原生 Agent 在桌面端是正确的形状。

BioClaw 团队向各项目维护者致以谢意。

---

## 参与贡献

分支策略、提交规范、代码风格、PR 检查清单都在 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。安全漏洞请发邮件到 **security@bioclaw.tech** 私下报告,**请不要开公开 issue**。

English README: [README.md](./README.md)。
