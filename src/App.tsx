/**
 * BioClaw Desktop — App root.
 *
 * Shell layered top-down:
 *   * TitleBar          — borderless Tauri window needs our own min/close.
 *   * EnvInstallBanner  — one-line progress while the bundled Python env
 *                          unpacks on first launch (silent on subsequent
 *                          launches once `~/.bioclaw/env/.venv` exists).
 *   * LocalChat         — the chat surface. Talks to the local Tauri-spawned
 *                          sidecar over 127.0.0.1; the sidecar then proxies
 *                          to chat.bioclaw.tech's `/api/desktop/chat/...`
 *                          using the user's OTP-issued bioclaw_session token.
 *   * SettingsDrawer    — right-side slide-out for account / model / env.
 *   * PermissionPrompt  — modal that appears when a skill script wants to
 *                          run a shell command for the first time.
 *
 * History: there used to be a `mode: 'remote' | 'local'` switch — 'remote'
 * rendered an iframe pointing at chat.bioclaw.tech. We dropped it in
 * preview13 because the SaaS sets `X-Frame-Options: DENY` (standard
 * clickjacking protection), so the iframe path was permanently broken —
 * users saw "已阻止此内容". Desktop is now a self-contained React UI à la
 * OmicOS; users who want the web SPA's other surfaces (lab / papers / ...)
 * keep using https://chat.bioclaw.tech in a browser.
 */
import { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { SettingsDrawer } from './components/SettingsDrawer';
import { GpuToolsPanel } from './components/GpuToolsPanel';
import { SaasHubPanel } from './components/SaasHubPanel';
import { LocalChat } from './components/LocalChat';
import { PermissionPrompt } from './components/PermissionPrompt';
import { LoginGate } from './components/LoginGate';
import { SetupWizard } from './components/SetupWizard';
import { EnvInstallBanner } from './components/EnvInstallBanner';
import { OfflineBanner } from './components/OfflineBanner';
import { useAppStore } from './lib/store';
import { useAuthStore } from './lib/auth-state';
import { useEnvStore } from './lib/env-state';
import { useSidecar } from './hooks/useSidecar';
import { initializeApp } from './lib/init';
import { setSaasSession, clearSaasSession } from './lib/api/saas';
import { useT } from './lib/i18n';

export function App() {
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const loginStep = useAuthStore((s) => s.loginStep);
  const t = useT();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initializeApp()
      .then(() => setReady(true))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('initializeApp failed', err);
        setError(message);
      });
  }, []);

  if (error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg p-8 text-center text-ink-soft">
        <div>
          <div className="text-lg font-semibold text-danger">{t('app.startupFailed')}</div>
          <pre className="mt-4 max-w-xl whitespace-pre-wrap text-sm">{error}</pre>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-sm text-muted">
        {t('app.initializing')}
      </div>
    );
  }

  // Email-login gate. Once the user signs in (or we've hydrated a token
  // from the OS keychain), loginStep flips to 'done' and we render the
  // normal shell. The custom TitleBar wraps LoginGate too — the
  // tauri.conf.json sets `decorations: false`, so without our own
  // titlebar the user has no minimise / close buttons on Windows
  // (macOS draws its native traffic-light buttons regardless).
  if (loginStep !== 'done') {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
        <TitleBar />
        <main className="relative flex-1 overflow-hidden">
          <LoginGate />
        </main>
      </div>
    );
  }

  return <AuthedShell isSettingsOpen={isSettingsOpen} />;
}

/**
 * Everything below LoginGate: sidecar lifecycle, env state machine,
 * and the chat shell. Pulled into its own component because it depends
 * on the sidecar hook (`useSidecar`), which we don't want paying for
 * during the unauthenticated bootstrap.
 */
function AuthedShell({ isSettingsOpen }: { isSettingsOpen: boolean }) {
  // Sidecar is always-on now (we dropped the remote-iframe path) —
  // LocalChat depends on it for the chat stream + script execution.
  const sidecar = useSidecar(true);
  const envState = useEnvStore((s) => s.state);
  const refreshEnv = useEnvStore((s) => s.refresh);
  // First poll once the sidecar reports a port, plus a 4-s heartbeat
  // so a parallel `bioclaw env setup` from the CLI eventually flips
  // the wizard out of view.
  useEffect(() => {
    if (!sidecar.port) return;
    void refreshEnv(sidecar.port);
    const id = setInterval(() => {
      if (sidecar.port) void refreshEnv(sidecar.port);
    }, 4000);
    return () => clearInterval(id);
  }, [sidecar.port, refreshEnv]);

  // Bridge the device-code/OTP session token (held in the auth store +
  // OS keychain) into the sidecar so the authenticated SaaS proxy
  // (/saas/*) can attach it. Covers boot (token hydrated from keychain),
  // fresh login (token set), and logout (token → null → clear). Without
  // this the GPU / chat-history / … panels would all 401.
  const authToken = useAuthStore((s) => s.token);
  useEffect(() => {
    if (sidecar.port == null) return;
    if (authToken) {
      void setSaasSession(sidecar.port, authToken).catch(() => undefined);
    } else {
      void clearSaasSession(sidecar.port);
    }
  }, [sidecar.port, authToken]);

  // Manual SetupWizard — opens for repair / extras only. The
  // OmicOS-style first-launch flow is driven entirely by the sidecar
  // (extract zip + offline sync, ~30-60 s) with an inline banner.
  const [wizardOpen, setWizardOpen] = useState(false);
  void envState;
  const isGpuOpen = useAppStore((s) => s.isGpuOpen);
  const toggleGpu = useAppStore((s) => s.toggleGpu);
  const isHubOpen = useAppStore((s) => s.isHubOpen);
  const toggleHub = useAppStore((s) => s.toggleHub);
  const t = useT();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <TitleBar />
      <EnvInstallBanner />
      <OfflineBanner port={sidecar.port} />
      <main className="relative flex-1 overflow-hidden">
        <LocalChat />
        {/* GPU tools launcher — opens the RNAGenesis / FoldMark / Boltz / … panel */}
        <div className="absolute bottom-4 left-4 z-10 flex gap-2">
          <button
            type="button"
            onClick={toggleGpu}
            title={t('nav.gpu')}
            className="rounded-full border border-line/40 bg-surface px-3 py-1.5 text-[12px] text-ink-soft shadow hover:text-ink"
          >
            {t('nav.gpu')}
          </button>
          <button
            type="button"
            onClick={toggleHub}
            title={t('nav.hub')}
            className="rounded-full border border-line/40 bg-surface px-3 py-1.5 text-[12px] text-ink-soft shadow hover:text-ink"
          >
            {t('nav.hub')}
          </button>
        </div>
        {isGpuOpen && <GpuToolsPanel port={sidecar.port} onClose={toggleGpu} />}
        {isHubOpen && <SaasHubPanel port={sidecar.port} onClose={toggleHub} />}
      </main>
      {isSettingsOpen ? <SettingsDrawer /> : null}
      <PermissionPrompt />
      {wizardOpen && sidecar.port !== null ? (
        <SetupWizard port={sidecar.port} onDone={() => setWizardOpen(false)} />
      ) : null}
    </div>
  );
}
