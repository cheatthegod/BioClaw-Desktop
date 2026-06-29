/**
 * Subscribe to a SaaS SSE endpoint through the sidecar proxy (M1.2).
 *
 * Each decoded `{ event, data }` frame is delivered to `onEvent`. The stream
 * is torn down on unmount or when `enabled`/`path` changes. 401 surfaces via
 * `needsAuth`.
 */
import { useEffect, useRef, useState } from 'react';

import { iterateSse, saasStream, SaasAuthError, type SseEvent } from '../lib/api/saas';

export interface UseSaasStreamOptions {
  enabled?: boolean;
  method?: string;
  body?: unknown;
  onEvent: (ev: SseEvent) => void;
  onError?: (err: Error) => void;
  onDone?: () => void;
}

export interface SaasStreamState {
  connected: boolean;
  needsAuth: boolean;
  error: Error | null;
}

export function useSaasStream(
  port: number | null,
  path: string,
  options: UseSaasStreamOptions,
): SaasStreamState {
  const { enabled = true, method, body, onEvent, onError, onDone } = options;
  const [connected, setConnected] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Keep latest callbacks without re-subscribing every render.
  const cbRef = useRef({ onEvent, onError, onDone });
  cbRef.current = { onEvent, onError, onDone };

  useEffect(() => {
    if (!enabled || port == null) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setConnected(false);
    setNeedsAuth(false);
    setError(null);

    (async () => {
      try {
        const res = await saasStream(port, path, {
          ...(method ? { method } : {}),
          ...(body !== undefined ? { body } : {}),
          signal: ctrl.signal,
        });
        if (cancelled) return;
        setConnected(true);
        for await (const ev of iterateSse(res, ctrl.signal)) {
          if (cancelled) return;
          cbRef.current.onEvent(ev);
        }
        if (!cancelled) cbRef.current.onDone?.();
      } catch (e) {
        if (cancelled || ctrl.signal.aborted) return;
        if (e instanceof SaasAuthError) {
          setNeedsAuth(true);
        } else {
          const err = e instanceof Error ? e : new Error(String(e));
          setError(err);
          cbRef.current.onError?.(err);
        }
      } finally {
        if (!cancelled) setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // body is intentionally excluded from deps — callers pass a stable value
    // per subscription; include `path`/`method`/`enabled`/`port`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, path, method, enabled]);

  return { connected, needsAuth, error };
}
