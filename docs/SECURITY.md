# Security Policy

This document covers (1) which versions get security fixes, (2) how to report a vulnerability privately, (3) the threat model we design against, (4) the mitigations actually shipped, and (5) the limitations we are aware of.

## Supported versions

| Version    | Status         | Receives security fixes |
| ---------- | -------------- | ----------------------- |
| `0.1.x`    | active (alpha) | yes                     |
| `< 0.1.0`  | pre-release    | no                      |

Once we ship `0.2.0`, only the latest minor on the latest major is supported. We will revisit a longer support window if and when an enterprise-distribution use case emerges. Until then, "latest only".

## Reporting a vulnerability

**Do not open a public GitHub issue.** Email **security@bioclaw.tech**.

What to include:

- A clear description of the vulnerability and the impact you believe it has.
- Reproduction steps or a proof-of-concept. Tarballs / screenshots are fine; please don't link to public gists.
- The version (`tauri.conf.json` `version`) and platform you observed it on.
- Your name and contact info for follow-up. Anonymous reports are accepted but slow us down.

If you need to encrypt, request our current PGP fingerprint in the first message. (We will publish the fingerprint inline here once the security mailbox is provisioned for PGP.)

Triage SLA:

- Acknowledgement: 5 business days.
- Triage decision (accepted / not-a-bug / duplicate): 10 business days.
- Fix-or-mitigation plan for confirmed issues: 30 days from acknowledgement.

We do not currently run a paid bug bounty. We do publish credit (CVE assignments plus your name in the release notes, or anonymous on request) when a fix ships.

## Threat model

The desktop client widens the attack surface of the BioClaw service in several concrete ways. We design against the following threats specifically:

### T1 — Prompt injection via remote-served content

The WebView loads `chat.bioclaw.tech` and renders whatever the agent / tools return. If a malicious paper, dataset, or tool output contains adversarial instructions, the model may follow them. In the desktop context this is materially worse than the browser context because the page is a few capabilities away from native code.

### T2 — Supply-chain compromise via npm or Cargo

The dependency closure at v0.1 is roughly 600 npm packages and 400 Cargo crates. Any single malicious release on the upgrade path could land malicious code in the installer. This is the threat most likely to actually land in practice.

### T3 — Malicious update package

If an attacker compromises the update endpoint or the signing key, they can push a tampered installer to every user on the next launch. This is the **highest-impact** threat because it bypasses every other control.

### T4 — OS clipboard exfiltration

The chat surface naturally reads and writes the clipboard (paste a SMILES string, copy a generated table). A malicious tool output could attempt to read the clipboard at an unexpected moment or write a poisoned payload that the user pastes elsewhere with elevated trust.

### T5 — Local file exfiltration

Phase 2 will introduce native file dialogs and (via MCP) filesystem servers. Any of those can become an exfiltration channel if the agent is induced to read sensitive files and embed them in a model response or a tool call to a remote MCP server.

### T6 — Side-loaded MCP servers (Phase 3)

User-installed MCP servers are arbitrary local code. The threat is not that we are tricked into running them, but that the user is tricked into installing one (typosquatting on a registry name, malicious recommendation in a chat thread, etc.).

## Mitigations in place

### Content Security Policy

Defined in `src-tauri/tauri.conf.json`:

- `connect-src` and `frame-src` only allow `https://chat.bioclaw.tech` and its subdomains.
- `script-src` is `'self'` only (no remote scripts; `'unsafe-eval'` is permitted for the Vite-built bundle).
- `style-src` is `'self' 'unsafe-inline'` (required for Tailwind runtime styles).
- `img-src` allows `'self' data: blob: https:` — images can come from any HTTPS origin, which is necessary for the chat UI to render figures and DOIs. This is the most permissive directive and is acceptable because images cannot execute.

### Capabilities allowlist

Tauri 2 requires explicit per-window permissions in `src-tauri/capabilities/`. The desktop starts from a minimal allowlist — `core:default`, `shell:allow-open` (URL-only), `notification:default`, `store:default` — and grows only with reviewed PRs. Even with all plugins registered in `lib.rs`, an unlisted command will be denied at runtime.

### Code signing and minisign-verified updates

- macOS: Developer ID Application certificate, notarized via `notarytool`. Configured in CI.
- Windows: Authenticode-signed installer (SmartScreen reputation will build over the first weeks; expect warnings on early downloads).
- Linux AppImage: minisign-signed update bundles only.
- The Tauri updater plugin verifies every downloaded update against the minisign public key embedded in `tauri.conf.json` before invoking the installer. **The public key in the scaffold today is a placeholder string** — it must be replaced with the real release key before v0.1.0 GA. The private key never leaves CI secrets.

### No telemetry by default

The shell sends no analytics, no crash dumps, no usage data. The only outbound request the desktop process itself makes (independent of the chat WebView) is the updater's manifest poll, which sends the current version and the OS target. Future telemetry, if any, will be off by default and require explicit opt-in.

### Lockfile-pinned dependencies

`package-lock.json` and `Cargo.lock` are committed. CI's dependency-review job (to be added on the first post-scaffold PR) will fail PRs that introduce vulnerable versions.

## Known limitations

- The placeholder updater pubkey is a release blocker, not a runtime risk in v0.1 alpha (the plugin is disabled in debug builds anyway), but it must be tracked publicly so it isn't forgotten.
- The four invoke handlers declared in `lib.rs` are not implemented in this scaffold; the capabilities file is correspondingly not authored. Both are landed before v0.1.0 GA.
- We do not yet enforce SBOMs or reproducible builds. Both are on the v0.2 roadmap.
- We rely on the user's OS to keep their system WebKit / WebView2 up to date. On unsupported Linux distros with a stale `webkit2gtk`, users may be exposed to engine-level CVEs that we cannot patch from this repo.
- Phase 2 sidecar and Phase 3 MCP servers expand the threat model significantly; a separate threat model addendum will be written before either ships.

---

If you find something not covered here, please tell us at **security@bioclaw.tech** — the model only works if we keep updating it.
