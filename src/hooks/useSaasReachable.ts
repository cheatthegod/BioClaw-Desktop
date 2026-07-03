/**
 * Poll whether the sidecar can reach the BioClaw SaaS (goal M3.2 offline mode).
 *
 * The proxy returns 502 when the upstream SaaS is unreachable (network down),
 * 401 when reachable-but-unauthenticated, and 2xx when online. We probe a cheap
 * endpoint (`/saas/config`) and classify:
 *   - fetch throws (sidecar itself unreachable) → 'unknown'
 *   - HTTP 502 (bad gateway from the proxy)      → 'offline'
 *   - any other HTTP status (200/401/403/…)      → 'online'
 *
 * Local-first features (chat, skills, Python env) keep working offline; only
 * the cloud panels degrade, so we surface a non-blocking banner.
 */
import { fetch } from '@tauri-apps/plugin-http'; // native fetch: bypasses webview CSP for local sidecar
import { useEffect, useState } from 'react';

export type Reachability = 'online' | 'offline' | 'unknown';

const PROBE_INTERVAL_MS = 20000;

export function useSaasReachable(port: number | null): Reachability {
  const [state, setState] = useState<Reachability>('unknown');

  useEffect(() => {
    if (port == null) {
      setState('unknown');
      return;
    }
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/saas/config`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        if (cancelled) return;
        setState(res.status === 502 ? 'offline' : 'online');
      } catch {
        if (!cancelled) setState('unknown');
      }
    };

    void probe();
    const id = window.setInterval(probe, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [port]);

  return state;
}
