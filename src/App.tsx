/**
 * BioClaw Desktop — App root.
 *
 * Phase 1 (thin client): we render an <iframe>-style WebView pointing at
 * chat.bioclaw.tech. The Tauri main window itself loads this React shell;
 * the React shell loads the remote chat URL in a nested webview-like frame
 * so we keep ownership of the menu bar, system tray, settings drawer, and
 * native interop (file dialogs, notifications). Once the local agent
 * sidecar lands in phase 2 we swap the URL based on user mode.
 *
 * The remote URL is wrapped via the Tauri webview API to bypass the iframe
 * sandbox while still keeping the CSP intact — see `useRemoteWebview`.
 */
import { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ConnectionGuard } from './components/ConnectionGuard';
import { LocalChat } from './components/LocalChat';
import { PermissionPrompt } from './components/PermissionPrompt';
import { LoginGate } from './components/LoginGate';
import { SetupWizard } from './components/SetupWizard';
import { EnvInstallBanner } from './components/EnvInstallBanner';
import { useAppStore } from './lib/store';
import { useAuthStore } from './lib/auth-state';
import { useEnvStore } from './lib/env-state';
import { useSidecar } from './hooks/useSidecar';
import { initializeApp } from './lib/init';

export function App() {
  const mode = useAppStore((s) => s.mode);
  const remoteUrl = useAppStore((s) => s.remoteUrl);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const loginStep = useAuthStore((s) => s.loginStep);
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
          <div className="text-lg font-semibold text-danger">启动失败</div>
          <pre className="mt-4 max-w-xl whitespace-pre-wrap text-sm">{error}</pre>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-sm text-muted">
        Initializing BioClaw…
      </div>
    );
  }

  // Email-login gate. Once the user signs in (or we've hydrated a token
  // from the OS keychain), loginStep flips to 'done' and we render the
  // normal shell.
  if (loginStep !== 'done') {
    return <LoginGate />;
  }

  return <AuthedShell mode={mode} remoteUrl={remoteUrl} isSettingsOpen={isSettingsOpen} />;
}

/**
 * Everything below LoginGate: sidecar lifecycle, env state machine,
 * and the actual chat shell. Pulled into its own component because it
 * depends on the sidecar hook (`useSidecar`), which we don't want
 * paying for during the unauthenticated bootstrap.
 */
function AuthedShell({
  mode,
  remoteUrl,
  isSettingsOpen,
}: {
  mode: 'local' | 'remote';
  remoteUrl: string;
  isSettingsOpen: boolean;
}) {
  const sidecar = useSidecar(mode === 'local');
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

  // Manual SetupWizard — opens for repair / extras only. The
  // OmicOS-style first-launch flow is now driven entirely by the
  // sidecar (extract zip + offline sync, ~30-60 s) with an inline
  // banner. The wizard is wired here purely as a stub for the
  // Settings-triggered extras / repair surface; that hook lives in
  // SettingsDrawer (TODO) and isn't user-visible yet.
  const [wizardOpen, setWizardOpen] = useState(false);
  void envState;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <TitleBar />
      <EnvInstallBanner />
      <main className="relative flex-1 overflow-hidden">
        {mode === 'local' ? (
          <LocalChat />
        ) : (
          <ConnectionGuard url={remoteUrl}>
            {/*
              iframe is acceptable here because we control the target host
              (chat.bioclaw.tech) and the CSP in index.html only whitelists it.
              For native-equivalent integration we'll move to a Tauri child
              WebView in phase 1.5.
            */}
            <iframe
              key={`${mode}-${remoteUrl}`}
              src={remoteUrl}
              title="BioClaw"
              className="h-full w-full border-0 bg-surface"
              allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"
            />
          </ConnectionGuard>
        )}
      </main>
      {isSettingsOpen ? <SettingsDrawer /> : null}
      <PermissionPrompt />
      {wizardOpen && sidecar.port !== null ? (
        <SetupWizard port={sidecar.port} onDone={() => setWizardOpen(false)} />
      ) : null}
    </div>
  );
}
