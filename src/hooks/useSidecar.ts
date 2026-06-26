/**
 * Polling hook for the local agent sidecar (Rust subprocess managed by Tauri).
 *
 * The sidecar exposes two Tauri commands that this hook talks to:
 *   - `sidecar_status` → `{ running: boolean; port: number | null }`
 *   - `start_sidecar`  → fire-and-forget; the next status poll observes it
 *
 * Behaviour:
 *   - When `enabled` flips true (mode→local), kick off `start_sidecar` once.
 *   - Poll `sidecar_status` every 2s while `enabled`.
 *   - Translate the raw flags into a coarser state machine: 'starting'
 *     (we asked it to start but haven't seen running=true yet), 'ready'
 *     (running && port), 'down' (the start command is still in flight or it
 *     crashed), 'error' (invoke threw).
 *
 * Phase-2 note: we do NOT restart the sidecar if it dies. The user can flip
 * mode back to remote and forward to surface the failure. A watchdog is on
 * the phase-3 list.
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { preloadPermissionsToSidecar } from '../lib/permission-state';

export type SidecarStatus = 'starting' | 'ready' | 'down' | 'error';

export interface SidecarState {
  status: SidecarStatus;
  port: number | null;
  errorText?: string;
}

interface SidecarStatusReply {
  running: boolean;
  port: number | null;
}

const POLL_INTERVAL_MS = 2000;

export function useSidecar(enabled: boolean): SidecarState {
  const [state, setState] = useState<SidecarState>({ status: 'down', port: null });
  const startedRef = useRef(false);
  const preloadedPortRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Reset so the next entry into local mode triggers another start.
      startedRef.current = false;
      setState({ status: 'down', port: null });
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const reply = await invoke<SidecarStatusReply>('sidecar_status');
        if (cancelled) return;
        if (reply.running && reply.port) {
          setState({ status: 'ready', port: reply.port });
          // First time we see a port (or it changed because the sidecar
          // restarted), push the persisted always-allow permission list
          // so the sidecar can skip the prompt on subsequent calls.
          if (preloadedPortRef.current !== reply.port) {
            preloadedPortRef.current = reply.port;
            void preloadPermissionsToSidecar(reply.port).catch(() => {});
          }
        } else {
          // Either we just asked it to start and it isn't up yet, or it
          // hasn't been asked at all this session.
          setState((prev) =>
            startedRef.current
              ? { status: 'starting', port: null }
              : prev.status === 'error'
                ? prev
                : { status: 'down', port: null },
          );
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', port: null, errorText: message });
      }
    };

    const startOnce = async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      try {
        await invoke('start_sidecar');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', port: null, errorText: message });
      }
    };

    void startOnce().then(() => void poll());
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return state;
}
