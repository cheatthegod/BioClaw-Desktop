/**
 * Poll the sidecar's local GPU-env probe (`GET /gpu/local-envs`).
 *
 * This hits the LOCAL sidecar directly (127.0.0.1), NOT the SaaS proxy — it
 * reports which GPU conda environments exist on *this* machine, so the panel
 * can signal a "run locally" option is possible (goal M3.1). Default execution
 * stays cloud; most desktops have no GPU and this returns an empty list.
 */
import { fetch } from '@tauri-apps/plugin-http'; // native fetch: bypasses webview CSP for local sidecar
import { useEffect, useState } from 'react';

const SIDECAR_HOST = '127.0.0.1';

interface LocalEnvs {
  envs: string[];
  localAvailable: boolean;
}

export function useLocalEnvs(port: number | null): LocalEnvs {
  const [state, setState] = useState<LocalEnvs>({ envs: [], localAvailable: false });

  useEffect(() => {
    if (port == null) return;
    let cancelled = false;
    fetch(`http://${SIDECAR_HOST}:${port}/gpu/local-envs`)
      .then((r) => (r.ok ? (r.json() as Promise<LocalEnvs>) : null))
      .then((d) => {
        if (!cancelled && d) setState({ envs: d.envs ?? [], localAvailable: !!d.localAvailable });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [port]);

  return state;
}
