/**
 * Renders children when the target URL is reachable, otherwise shows an
 * inline retry banner. We don't fail-stop — the user can still open settings
 * and switch mode — but we surface offline state explicitly.
 */
import { useEffect, useState } from 'react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

interface Props {
  url: string;
  children: React.ReactNode;
  intervalMs?: number;
}

export function ConnectionGuard({ url, children, intervalMs = 15_000 }: Props) {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        // HEAD with a short timeout. We use the Tauri http plugin so we
        // bypass the WebView's CORS rules — the upstream BioClaw server
        // doesn't set CORS headers for arbitrary origins.
        const res = await tauriFetch(url, {
          method: 'HEAD',
          connectTimeout: 4000,
        });
        if (!cancelled) setReachable(res.ok || res.status < 500);
      } catch {
        if (!cancelled) setReachable(false);
      }
    };
    void probe();
    const id = setInterval(probe, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, intervalMs]);

  return (
    <div className="relative h-full w-full">
      {reachable === false ? (
        <div className="absolute inset-x-0 top-0 z-10 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800">
          Cannot reach <code className="font-mono">{url}</code>. Retrying every {Math.round(intervalMs / 1000)}s…
        </div>
      ) : null}
      {children}
    </div>
  );
}
