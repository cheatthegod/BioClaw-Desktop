import { ChatThreadDefinition } from '../types.js';
import { getDb } from './connection.js';

function mapRow(
  row: {
    id: string;
    chat_jid: string;
    title: string;
    workspace_folder: string;
    agent_id: string;
    created_at: string;
    updated_at: string;
    archived: number | null;
  },
): ChatThreadDefinition {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    title: row.title,
    workspaceFolder: row.workspace_folder,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
  };
}

export function getChatThreads(chatJid: string): ChatThreadDefinition[] {
  const db = getDb();
  const rows = db.prepare(
    `
      SELECT *
      FROM chat_threads
      WHERE chat_jid = ? AND (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC, created_at DESC
    `,
  ).all(chatJid) as Array<{
    id: string;
    chat_jid: string;
    title: string;
    workspace_folder: string;
    agent_id: string;
    created_at: string;
    updated_at: string;
    archived: number | null;
  }>;
  return rows.map(mapRow);
}

export function getChatThread(threadId: string): ChatThreadDefinition | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM chat_threads WHERE id = ?',
  ).get(threadId) as
    | {
        id: string;
        chat_jid: string;
        title: string;
        workspace_folder: string;
        agent_id: string;
        created_at: string;
        updated_at: string;
        archived: number | null;
      }
    | undefined;
  return row ? mapRow(row) : undefined;
}

export function upsertChatThread(thread: ChatThreadDefinition): void {
  const db = getDb();
  db.prepare(
    `
      INSERT OR REPLACE INTO chat_threads (
        id, chat_jid, title, workspace_folder, agent_id, created_at, updated_at, archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    thread.id,
    thread.chatJid,
    thread.title,
    thread.workspaceFolder,
    thread.agentId,
    thread.createdAt,
    thread.updatedAt,
    thread.archived ? 1 : 0,
  );
}

export function archiveChatThread(threadId: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE chat_threads SET archived = 1, updated_at = ? WHERE id = ?',
  ).run(new Date().toISOString(), threadId);
}

