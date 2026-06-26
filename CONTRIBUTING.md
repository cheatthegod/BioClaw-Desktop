# Contributing to BioClaw Desktop

Thanks for your interest. The desktop client is a small, fast-moving repo at this stage, so the rules below are intentionally short.

## Dev setup

You need:

- **Node.js 20+** (22 LTS recommended). The `engines` field in `package.json` enforces this; install via [`nvm`](https://github.com/nvm-sh/nvm) or `volta`.
- **npm 10+**. Pinned implicitly by Node 20.
- **Rust stable** via `rustup`. `cargo --version` should report 1.77 or newer; older toolchains will fail to compile `tauri-build` 2.0.
- Platform-specific system dependencies. See [`docs/BUILD.md`](./docs/BUILD.md). Briefly:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Windows**: MSVC build tools (the C++ workload in Visual Studio Build Tools), WebView2 runtime (Win10 1809+ ships it preinstalled on most editions).
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `pkg-config`.

Bootstrap:

```bash
git clone https://github.com/bioclaw/bioclaw-desktop.git
cd bioclaw-desktop
npm install
npm run tauri:dev
```

The first launch compiles the Rust side from scratch; it can take 5+ minutes. Subsequent runs are incremental.

## Branch strategy

`main` only. There are no long-lived development branches. Everything is a short-lived feature branch off `main` (`feat/...`, `fix/...`, `chore/...`, `docs/...`) merged back via PR. Releases are cut by tagging `vX.Y.Z` on `main`.

**Do not push directly to `main`.** Protected branch rules will reject force pushes; PRs require at least one approving review and green CI.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). The common prefixes you should use:

- `feat:` — user-visible new functionality
- `fix:` — user-visible bug fix
- `chore:` — internal plumbing, no behavior change
- `docs:` — documentation only
- `refactor:` — no behavior change, no docs
- `perf:` — measurable performance work, include the number in the body
- `build:` — bundler / Cargo / CI config
- `test:` — adding or fixing tests

Scope the prefix when it's clarifying — `feat(tray): add badge count`, `fix(updater): handle 304 from CDN` — but don't force a scope just for the sake of it.

Commit message bodies are encouraged for anything non-trivial. Explain **why**, not what.

## Code style

- **TypeScript / React**: Prettier (config in `package.json`, default options + 2-space indent), ESLint with `@typescript-eslint`, `react`, and `react-hooks` plugins. `npm run lint` must pass with **zero warnings**; `npm run format:check` must pass in CI.
- **Rust**: `cargo fmt --all` for formatting, `cargo clippy --all-targets --all-features -- -D warnings` for lint. Run both before opening a PR.
- **Files**: 100-column soft limit. UTF-8 LF endings. No tabs except in Makefiles.
- **Imports**: absolute paths from `src/` are preferred for cross-feature imports; relative for same-feature.

## Tests

- Frontend: [`vitest`](https://vitest.dev/) for unit tests, colocated as `*.test.ts(x)` next to the unit under test. Coverage is not yet gated but is reported in CI.
- Rust: `cargo test` for unit tests inside the crate; integration tests under `src-tauri/tests/`.

There is **no** end-to-end harness wired up yet (Phase 1 doesn't justify the maintenance cost — almost every meaningful flow happens inside `chat.bioclaw.tech`'s own UI, which has its own E2E suite). If you add a Tauri command, you must add a unit test for it.

## Security

**Do not file public issues for vulnerabilities.** Email **security@bioclaw.tech** with the details. Encrypt with our PGP key if you have one — the fingerprint is published in [`docs/SECURITY.md`](./docs/SECURITY.md) (placeholder for now). Triage SLA is 5 business days for acknowledgement, 30 days for a fix-or-mitigation plan on confirmed reports.

## PR checklist

Before clicking "Ready for review":

- [ ] Branched off latest `main` and rebased (not merged) if `main` has moved.
- [ ] `npm run lint && npm run typecheck` passes locally.
- [ ] `cargo fmt --check && cargo clippy -- -D warnings` passes locally.
- [ ] `npm test` and `cargo test` pass locally.
- [ ] New Tauri commands have unit tests **and** matching `capabilities/default.json` entries.
- [ ] If the change touches IPC, CSP, or the updater, you've explicitly called this out in the PR description and tagged a reviewer with security context.
- [ ] If you added a user-facing string, both `README.md` and `README.zh-CN.md` are updated where relevant.
- [ ] Commit history is clean (squashed if appropriate); the merge commit message will follow the lead commit.

## How to add a new Tauri command

Two things must change in lockstep:

1. **The Rust handler** in `src-tauri/src/commands.rs`. Annotate the function with `#[tauri::command]`, take typed arguments, return `Result<T, String>` (or a `thiserror` error type). Add it to the `invoke_handler` list in `src-tauri/src/lib.rs`.

2. **The capability allowlist** in `src-tauri/capabilities/default.json`. Tauri 2 requires every command to be explicitly allowed for the window that invokes it; an unlisted command will fail at runtime with a permission error. Use the most restrictive scope you can — `permissions` should reference the command-specific token, not a wildcard.

Then write the frontend wrapper in `src/lib/ipc.ts` (create the file if it doesn't exist) — a typed `invoke<T>('your_command', { ... })` helper plus a vitest unit test that mocks `@tauri-apps/api/core`.

For anything touching the filesystem, shell, HTTP, or external URLs: add a paragraph to [`docs/SECURITY.md`](./docs/SECURITY.md) noting what the new attack surface is and how it's gated.

---

By contributing you agree your work is licensed MIT, same as the project.
