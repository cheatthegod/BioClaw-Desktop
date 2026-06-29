/**
 * React hooks over the SaaS proxy client (M1.2).
 *
 *   useSaasQuery(port, path)  — GET + JSON, with loading/error/data + refetch.
 *   useSaasStream(...)        — subscribe to an SSE endpoint, see useSaasStream.ts.
 *
 * `port` is the local sidecar port (from `useSidecar`). When it is null (the
 * sidecar isn't ready yet) the query stays idle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { saasGet, SaasAuthError, type SaasError } from '../lib/api/saas';

export interface SaasQueryState<T> {
  data: T | null;
  loading: boolean;
  /** Non-null when the last fetch failed for a non-auth reason. */
  error: SaasError | Error | null;
  /** True when the failure was a 401 — the UI should prompt re-auth. */
  needsAuth: boolean;
  refetch: () => void;
}

export interface UseSaasQueryOptions {
  /** Skip the request (e.g. panel not visible). Default true. */
  enabled?: boolean;
  /** Re-fetch on an interval (ms). 0/undefined = no polling. */
  refetchIntervalMs?: number;
}

export function useSaasQuery<T = unknown>(
  port: number | null,
  path: string,
  options: UseSaasQueryOptions = {},
): SaasQueryState<T> {
  const { enabled = true, refetchIntervalMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SaasError | Error | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || port == null) return;
    let cancelled = false;
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    saasGet<T>(port, path, { signal: ctrl.signal })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || ctrl.signal.aborted) return;
        setLoading(false);
        if (e instanceof SaasAuthError) {
          setNeedsAuth(true);
          setError(null);
        } else {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [port, path, enabled, nonce]);

  // Optional polling.
  useEffect(() => {
    if (!enabled || port == null || !refetchIntervalMs) return;
    const id = window.setInterval(refetch, refetchIntervalMs);
    return () => window.clearInterval(id);
  }, [enabled, port, refetchIntervalMs, refetch]);

  return { data, loading, error, needsAuth, refetch };
}
