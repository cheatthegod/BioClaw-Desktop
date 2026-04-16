import { getDb } from './connection.js';

export interface AgentTraceRow {
  id: number;
  group_folder: string;
  chat_jid: string | null;
  session_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}

export function insertAgentTraceEvent(params: {
  group_folder: string;
  chat_jid?: string;
  session_id?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}): AgentTraceRow {
  const db = getDb();
  const created_at = new Date().toISOString();
  const payloadJson = JSON.stringify(params.payload ?? {});
  const result = db
    .prepare(
      `INSERT INTO agent_trace_events (group_folder, chat_jid, session_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.group_folder,
      params.chat_jid ?? null,
      params.session_id ?? null,
      params.type,
      payloadJson,
      created_at,
    );
  return {
    id: Number(result.lastInsertRowid),
    group_folder: params.group_folder,
    chat_jid: params.chat_jid ?? null,
    session_id: params.session_id ?? null,
    type: params.type,
    payload: payloadJson,
    created_at,
  };
}

/** Safe fragment for SQL `IN` / `NOT IN` (event type names only). */
function sanitizeTraceTypeFilters(types: string[] | undefined): string[] {
  if (!types?.length) return [];
  return types.filter((t) => /^[a-zA-Z0-9_-]+$/.test(t));
}

export function getAgentTraceEvents(options: {
  group_folder?: string;
  limit?: number;
  /** Exclude these event types from results (applied in SQL before LIMIT). */
  omit_types?: string[];
}): AgentTraceRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
  const omit = sanitizeTraceTypeFilters(options.omit_types);
  if (omit.length === 0) {
    if (options.group_folder) {
      return db
        .prepare(
          `SELECT id, group_folder, chat_jid, session_id, type, payload, created_at
           FROM agent_trace_events
           WHERE group_folder = ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(options.group_folder, limit) as AgentTraceRow[];
    }
    return db
      .prepare(
        `SELECT id, group_folder, chat_jid, session_id, type, payload, created_at
         FROM agent_trace_events
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as AgentTraceRow[];
  }

  const placeholders = omit.map(() => '?').join(', ');
  if (options.group_folder) {
    return db
      .prepare(
        `SELECT id, group_folder, chat_jid, session_id, type, payload, created_at
         FROM agent_trace_events
         WHERE group_folder = ? AND type NOT IN (${placeholders})
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(options.group_folder, ...omit, limit) as AgentTraceRow[];
  }
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, session_id, type, payload, created_at
       FROM agent_trace_events
       WHERE type NOT IN (${placeholders})
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...omit, limit) as AgentTraceRow[];
}
