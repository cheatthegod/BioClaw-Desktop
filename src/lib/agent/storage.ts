// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original source: packages/opencode/src/session/session.ts (the durable event
// log that lets opencode resume an interrupted session). We strip out the
// SQLite plumbing and the Effect Layer wiring; phase 2 will plug a
// `TauriStoreSessionStorage` impl in over `tauri-plugin-store`.

import type { AgentEvent, AgentMessage } from './types';

/**
 * A snapshot of a session at rest. We persist enough to reconstruct the
 * conversation and replay events to a UI that joined late.
 *
 * Note `events` is append-only — the runner writes BEFORE executing a tool,
 * which is what makes resume safe across crashes (opencode's invariant).
 */
export interface SessionRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly events: ReadonlyArray<AgentEvent>;
  readonly status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  /** Free-form metadata: model id, system prompt hash, etc. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionStorage {
  load(sessionId: string): Promise<SessionRecord | null>;
  create(record: SessionRecord): Promise<void>;
  appendMessage(sessionId: string, message: AgentMessage): Promise<void>;
  /** Append BEFORE acting on the event — durable replay relies on this. */
  appendEvent(sessionId: string, event: AgentEvent): Promise<void>;
  setStatus(sessionId: string, status: SessionRecord['status']): Promise<void>;
  list(): Promise<
    ReadonlyArray<{ id: string; updatedAt: number; status: SessionRecord['status'] }>
  >;
  delete(sessionId: string): Promise<void>;
}

/**
 * In-memory storage. Useful for tests and as the default during phase 1 when
 * the React UI just iframes chat.bioclaw.tech — no real persistence needed yet.
 * Phase 2 swaps this for a `tauri-plugin-store`-backed impl.
 */
export class MemorySessionStorage implements SessionStorage {
  private readonly sessions = new Map<string, MutableRecord>();

  async load(sessionId: string): Promise<SessionRecord | null> {
    const r = this.sessions.get(sessionId);
    return r ? snapshot(r) : null;
  }

  async create(record: SessionRecord): Promise<void> {
    if (this.sessions.has(record.id)) {
      throw new Error(`Session ${record.id} already exists`);
    }
    this.sessions.set(record.id, {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: record.messages.slice(),
      events: record.events.slice(),
      status: record.status,
      metadata: record.metadata,
    });
  }

  async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    const r = this.require(sessionId);
    r.messages.push(message);
    r.updatedAt = Date.now();
  }

  async appendEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const r = this.require(sessionId);
    r.events.push(event);
    r.updatedAt = Date.now();
  }

  async setStatus(sessionId: string, status: SessionRecord['status']): Promise<void> {
    const r = this.require(sessionId);
    r.status = status;
    r.updatedAt = Date.now();
  }

  async list(): Promise<
    ReadonlyArray<{ id: string; updatedAt: number; status: SessionRecord['status'] }>
  > {
    return Array.from(this.sessions.values())
      .map((r) => ({ id: r.id, updatedAt: r.updatedAt, status: r.status }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  private require(sessionId: string): MutableRecord {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error(`Session ${sessionId} not found`);
    return r;
  }
}

interface MutableRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
  events: AgentEvent[];
  status: SessionRecord['status'];
  metadata?: Readonly<Record<string, unknown>>;
}

function snapshot(r: MutableRecord): SessionRecord {
  return {
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messages: r.messages.slice(),
    events: r.events.slice(),
    status: r.status,
    metadata: r.metadata,
  };
}
