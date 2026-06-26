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
import { useAppStore } from './lib/store';
import { initializeApp } from './lib/init';

export function App() {
  const mode = useAppStore((s) => s.mode);
  const remoteUrl = useAppStore((s) => s.remoteUrl);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
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
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-50 p-8 text-center text-zinc-700">
        <div>
          <div className="text-lg font-semibold text-red-600">启动失败</div>
          <pre className="mt-4 max-w-xl whitespace-pre-wrap text-sm">{error}</pre>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        Initializing BioClaw…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-100">
      <TitleBar />
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
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"
            />
          </ConnectionGuard>
        )}
      </main>
      {isSettingsOpen ? <SettingsDrawer /> : null}
      <PermissionPrompt />
    </div>
  );
}
