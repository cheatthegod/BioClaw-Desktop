# BioClaw Desktop — Release Runbook

This document is the source of truth for cutting a BioClaw Desktop release.
It covers the CI/CD flow, how to rotate signing secrets, and the platform
gotchas we have hit in the past.

## TL;DR — cut a release

1. Bump the version in **both** files (they must match):
   - `package.json` -> `"version"`
   - `src-tauri/tauri.conf.json` -> `"version"`
   - `src-tauri/Cargo.toml` -> `[package] version`
2. Commit and merge to `main`.
3. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. Watch the `Release` workflow in GitHub Actions. When all three matrix legs
   are green, a **draft** GitHub Release titled `BioClaw v0.2.0` will exist
   with macOS / Windows / Linux artifacts attached plus `latest.json` for the
   updater.
5. Smoke-test each installer (see "Manual smoke test" below), then click
   **Publish release** in the GitHub UI. The updater clients only check
   published releases.

## How the CI flow works

We run two workflows:

### `ci.yml` — every push/PR to `main`
- `lint` (Ubuntu): `npm ci`, `typecheck`, `eslint`, `prettier --check`
- `rust-check` (Ubuntu): `cargo fmt --check`, `cargo clippy -D warnings`
- `build-matrix` (Linux/macOS/Windows): full Tauri bundle as a smoke test,
  artifacts uploaded for inspection but **no GitHub Release is created**
  (`tagName: ''` tells `tauri-action` to skip the release step).

### `release.yml` — only on `v*.*.*` tags
- Same three-OS matrix, but `tauri-action` is invoked with:
  - `tagName: ${{ github.ref_name }}`
  - `releaseName: 'BioClaw v__VERSION__'`
  - `releaseDraft: true`
  - `includeUpdaterJson: true`
- All three legs append their artifacts to the same draft Release.
  `tauri-action` is idempotent here — the first leg creates the draft,
  later legs just upload.
- Code signing happens in-line: the macOS leg notarizes via Apple's
  `notarytool`; the Windows leg signs the NSIS installer with the EV cert;
  every platform produces a `.sig` minisign signature for the updater.

There is intentionally **no separate `publish` job** — `tauri-action`
does the upload, and we leave the release as a draft so a human can
verify the binaries before flipping it to "published."

## Required GitHub Secrets

Configure these under **Settings -> Secrets and variables -> Actions**.

### macOS code-signing + notarization
| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` of your Developer ID Application cert |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: BioClaw Inc (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-char Apple Developer team ID |

### Windows code-signing
| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | Base64-encoded `.p12` / `.pfx` of your code-signing cert |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.p12` |

### Updater (minisign)
| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the minisign private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase that protects the key |

The matching **public** key lives in `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. Clients refuse to install updates that don't
verify against this pubkey — keep them in sync.

## Rotating signing secrets

### Updater key (minisign)
1. On a trusted machine: `npm run tauri signer generate -- -w ~/.tauri/bioclaw.key`
2. Copy the printed **public** key into `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`).
3. Copy the **private** key file contents into the `TAURI_SIGNING_PRIVATE_KEY`
   secret, and the passphrase into `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. **Rotation gotcha**: existing installs trust the *old* pubkey. After
   rotating, ship one final update signed with the old key that swaps the
   embedded pubkey to the new one; then start signing with the new key on
   the next release. Otherwise older clients will silently stop updating.

### macOS cert
1. Renew the Developer ID Application cert in Apple Developer portal.
2. Export to `.p12` with a strong password.
3. `base64 -i developer-id.p12 | pbcopy` and paste into `APPLE_CERTIFICATE`.
4. Update `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`
   (the identity string changes when the cert is reissued).

### Windows cert
Same process as macOS — re-export to `.p12`, base64-encode, update
`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`.

### Apple notarization password
`APPLE_PASSWORD` is an **app-specific password**, not your Apple ID
password. Regenerate at <https://appleid.apple.com> -> Sign-In and Security
-> App-Specific Passwords whenever it leaks or expires.

## Manual smoke test before publishing

- **macOS universal**: download the `.dmg`, drag to /Applications, launch.
  Confirm Gatekeeper accepts it without "unidentified developer" warning
  (proves notarization stapled correctly).
- **Windows NSIS**: download the `.exe` installer, run it — UAC prompt
  should show "BioClaw" as the verified publisher (proves the EV cert
  is valid).
- **Linux AppImage**: `chmod +x BioClaw_*.AppImage && ./BioClaw_*.AppImage`.
  On distros without an AppImage runtime, prompt the user to install
  `libfuse2`.
- **Updater**: install the previous release first, then trigger an update
  check — the new release should download and install without a "signature
  verification failed" error.

## Platform gotchas

### macOS — notarization wait time
Apple's `notarytool` typically completes in 2–10 minutes but has been
observed to take **up to 45 minutes** during WWDC week. Don't cancel the
job; the 90-min job timeout in `release.yml` is sized for the worst case.
If notarization fails with `Invalid` status, the most common cause is a
missing hardened-runtime entitlement — check `src-tauri/Entitlements.plist`.

### Windows — NSIS UAC prompt
`installMode: perMachine` (set in `tauri.conf.json`) means every install
triggers a UAC elevation prompt. This is required for the updater to be
able to overwrite files in `Program Files` later. If you switch to
`perUser`, the UAC prompt goes away but the updater will fail on
machines where another user installed BioClaw first.

### Linux — AppImage runtime
AppImage requires FUSE on the host. Ubuntu 24.04+ ships only `libfuse3`;
AppImages built for FUSE 2 need `sudo apt install libfuse2`. We bundle
`bundleMediaFramework: true` to avoid GStreamer codec drift, but the FUSE
piece is on the user's system. Document this in the release notes.

### Linux — webkit2gtk ABI
We build on `ubuntu-22.04` (webkit2gtk-4.1). Building on `ubuntu-24.04`
produces binaries that won't run on 22.04 hosts due to a webkit ABI bump.
Do not change the runner without testing on a 22.04 VM.

### Universal macOS build
We pass `--target universal-apple-darwin` on `macos-14` (an arm64 runner).
This builds both arches in one shot via `lipo`. If a Rust dependency
ships only x86_64 prebuilt binaries (rare), the universal build fails
with `lipo: ... has no architecture aarch64` — pin that dep to a version
with arm64 support or drop universal for that release.

## Re-running a failed release

`tauri-action` does not delete a half-populated draft release. If a
matrix leg fails:
1. Delete the draft release in the GitHub UI.
2. Delete the tag locally and remotely: `git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0`.
3. Fix the failure, retag, push.

Tags are cheap; do not try to re-run the workflow against the same tag
without deleting the draft first or you'll get duplicate assets.
