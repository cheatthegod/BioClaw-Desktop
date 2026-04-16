import { getDb } from './connection.js';
import { safeJsonParse } from './utils.js';
import { RegisteredGroup, ContainerConfig } from '../types.js';

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  workspace_folder: string | null;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  archived: number | null;
}

function mapRow(row: GroupRow): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    workspaceFolder: row.workspace_folder || row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: safeJsonParse<ContainerConfig | undefined>(row.container_config, undefined),
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    archived: row.archived === 1,
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as GroupRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, workspace_folder, trigger_pattern, added_at, container_config, requires_trigger, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.workspaceFolder || group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.archived ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as GroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const mapped = mapRow(row);
    result[row.jid] = mapped;
  }
  return result;
}
