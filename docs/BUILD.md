# Build Guide

How to produce a BioClaw Desktop bundle on each supported OS, how to inspect the result, and how to recover from the failure modes we've already hit.

The npm scripts (`npm run tauri:build:mac|win|linux`) are the canonical entrypoint. Everything in this document is what those scripts assume about your machine.

## macOS

### System dependencies

- macOS 12 Monterey or newer (Sonoma+ recommended).
- Xcode Command Line Tools: `xcode-select --install`.
- Rust stable via `rustup`, plus both architecture targets for a universal build:

  ```bash
  rustup target add x86_64-apple-darwin aarch64-apple-darwin
  ```

- Optional but recommended:

  ```bash
  brew install create-dmg minisign apple-codesign
  ```

  `apple-codesign` (the `rcodesign` CLI) is what we use to verify the signed bundle offline — it's optional unless you're debugging notarization.

### Build

```bash
npm install
npm run tauri:build:mac
```

Output: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/BioClaw_0.1.0_universal.dmg`.

For unsigned dev builds the `signingIdentity` field in `tauri.conf.json` stays `null`; for signed releases CI overrides it via env (`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`). See `.github/workflows/release.yml` once that lands.

## Windows

### System dependencies

- Windows 10 1809+ or Windows 11.
- Visual Studio Build Tools 2022 with the "Desktop development with C++" workload installed (`vs_buildtools.exe --add Microsoft.VisualStudio.Workload.VCTools`).
- WebView2 Runtime: usually preinstalled; if not, get the Evergreen Bootstrapper from Microsoft.
- Rust stable via `rustup-init.exe`, plus the MSVC target:

  ```powershell
  rustup target add x86_64-pc-windows-msvc
  ```

- For installer authoring: `winget install --id WiXToolset.WiXToolset` (WiX 3.x for the `.msi` codepath; NSIS is bundled by Tauri).

### Build

```powershell
npm install
npm run tauri:build:win
```

Output: `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\BioClaw_0.1.0_x64-setup.exe` and `...\msi\BioClaw_0.1.0_x64_en-US.msi`. The NSIS installer is signed by CI via `certificateThumbprint`; the MSI is signed separately with `signtool.exe`.

## Linux

### System dependencies

Ubuntu 22.04 (the CI target):

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  build-essential \
  curl \
  wget \
  file \
  pkg-config \
  patchelf
```

Fedora 39+:

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  gtk3-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  openssl-devel \
  curl wget file
```

Arch:

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg \
  base-devel openssl curl wget file
```

Then Rust stable via `rustup`.

### Build

```bash
npm install
npm run tauri:build:linux
```

Output:

- `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/BioClaw_0.1.0_amd64.AppImage`
- `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/bioclaw_0.1.0_amd64.deb`

The `.deb` `depends` field is set in `tauri.conf.json` to `libwebkit2gtk-4.1-0` and `libgtk-3-0`. Distros that ship only `libwebkit2gtk-4.0` (Ubuntu 20.04 and older) cannot install the package as-is.

## Self-signed dev cert for the updater

You can exercise the updater path locally without minting a release key:

```bash
# install minisign locally
brew install minisign            # mac
sudo apt install minisign        # debian/ubuntu
# or via cargo: cargo install rsign2 (compatible CLI)

# generate a dev keypair (DO NOT use for releases)
minisign -G -p dev.pub -s dev.key

# sign a built bundle
minisign -S -s dev.key -m src-tauri/target/release/bundle/<artifact>

# put the contents of dev.pub (base64, single line) into tauri.conf.json
# plugins.updater.pubkey, rebuild, and point updater.endpoints at a local
# static server (e.g. `python -m http.server`) that serves a manifest
# pointing at the signed artifact.
```

**Never commit the dev keypair.** Add `dev.key` and `dev.pub` to `.gitignore` if you generate them at the repo root.

## Inspecting the produced bundle

### macOS `.dmg`

```bash
hdiutil attach BioClaw_0.1.0_universal.dmg
ls -la "/Volumes/BioClaw 0.1.0/BioClaw.app/Contents/MacOS/"
codesign --verify --deep --strict --verbose=4 "/Volumes/BioClaw 0.1.0/BioClaw.app"
spctl --assess --type execute --verbose "/Volumes/BioClaw 0.1.0/BioClaw.app"
hdiutil detach "/Volumes/BioClaw 0.1.0"
```

### Windows `.exe` / `.msi`

```powershell
Get-AuthenticodeSignature .\BioClaw_0.1.0_x64-setup.exe
signtool verify /pa /v .\BioClaw_0.1.0_x64-setup.exe
# expand the MSI to see what's inside without installing:
msiexec /a BioClaw_0.1.0_x64_en-US.msi /qb TARGETDIR=C:\tmp\bioclaw-msi
```

### Linux `.AppImage` and `.deb`

```bash
# AppImage is just a squashfs-prefixed ELF; you can mount it:
./BioClaw_0.1.0_amd64.AppImage --appimage-mount
# in another shell, ls the mountpoint it prints

# inspect the deb
dpkg -c bioclaw_0.1.0_amd64.deb       # list contents
dpkg -e bioclaw_0.1.0_amd64.deb /tmp/bc-deb && cat /tmp/bc-deb/control
```

## Troubleshooting

### `error: failed to find libwebkit2gtk-4.1` on Linux

You have webkit2gtk **4.0** installed (Ubuntu 20.04, Debian 11). The 4.1 series shipped with Ubuntu 22.04 / Debian 12. Upgrade your distro or build inside a 22.04 container.

### `error: linking with cc failed` on Linux

Usually a missing system dep — re-run the apt block above. If it still fails, check that `pkg-config --libs webkit2gtk-4.1` resolves; if it doesn't, your `PKG_CONFIG_PATH` is missing the right directory (most often `/usr/lib/x86_64-linux-gnu/pkgconfig`).

### macOS: `Codesign check failed: rcodesign not found`

You're using the optional `apple-codesign` CLI to verify locally and didn't install it. Either `brew install apple-codesign` or skip the verify step — codesign verification still works via the built-in `codesign` tool shown above.

### Windows SmartScreen "Windows protected your PC"

Expected for newly signed installers until SmartScreen reputation accrues (a few hundred downloads, typically over 1-2 weeks). Users can click **More info → Run anyway**. Once we have an EV cert, this disappears immediately. Standard cert: expect the warning for the first cohort.

### `npm run tauri:dev` opens an empty white window on Linux

Almost always a `webkit2gtk` GPU acceleration crash. Run with `WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri:dev`. If that fixes it, file an upstream issue with your `glxinfo | head` and we'll add the env var to the launch script for affected distros.

### `tauri-plugin-updater` not registered in debug build

Intentional — see `src-tauri/src/lib.rs`. To test the updater, do a release build.

### `Cargo.toml` won't compile on Rust 1.76

`rust-version = 1.77` is the floor. Run `rustup update stable`.

---

If you hit something not listed here, open a `chore(build): ...` PR adding it to this file once you've found the fix. Future-you will thank you.
