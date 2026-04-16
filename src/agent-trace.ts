import {
  insertAgentTraceEvent,
  type AgentTraceRow,
} from './db/index.js';

export type { AgentTraceRow };

type TraceListener = (row: AgentTraceRow) => void;

let traceListener: TraceListener | null = null;

export function setAgentTraceListener(fn: TraceListener | null): void {
  traceListener = fn;
}

/**
 * Persist a trace row and notify the dashboard SSE subscribers (if any).
 */
export function recordAgentTraceEvent(params: {
  group_folder: string;
  chat_jid?: string;
  session_id?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}): AgentTraceRow | undefined {
  let row: AgentTraceRow;
  try {
    row = insertAgentTraceEvent(params);
  } catch {
    /* e.g. unit tests without initDatabase() */
    return undefined;
  }
  try {
    traceListener?.(row);
  } catch {
    /* avoid breaking orchestrator */
  }
  return row;
}
