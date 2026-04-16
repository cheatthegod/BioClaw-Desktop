/**
 * Session Manager — manages Claude Agent SDK session IDs and router state.
 */
import { logger } from './logger.js';
import {
  archiveChatThread,
  ensureDefaultAgentForWorkspace,
  getAllAgents,
  getAllDefaultChatAgentBindings,
  getChatThreads,
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setDefaultChatAgentBinding,
  upsertAgent,
  upsertChatThread,
} from './db/index.js';
import { AgentDefinition, ChatThreadDefinition, RegisteredGroup } from './types.js';
import { ensureGroupDir } from './group-folder.js';
import {
  getWorkspaceChatJids,
  getWorkspaceFolder,
  normalizeRegisteredGroup,
} from './workspace.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let agents: Record<string, AgentDefinition> = {};
let chatAgentBindings: Record<string, string> = {};
let lastAgentTimestamp: Record<string, string> = {};

export function getLastTimestamp(): string {
  return lastTimestamp;
}

export function setLastTimestamp(ts: string): void {
  lastTimestamp = ts;
}

export function getSessions(): Record<string, string> {
  return sessions;
}

export function updateSession(agentId: string, sessionId: string): void {
  sessions[agentId] = sessionId;
  setSession(agentId, sessionId);
}

export function getRegisteredGroupsMap(): Record<string, RegisteredGroup> {
  return registeredGroups;
}

export function getAgentsMap(): Record<string, AgentDefinition> {
  return agents;
}

export function getAgentIdForChat(chatJid: string): string | undefined {
  return chatAgentBindings[chatJid];
}

export function getAgentForChat(chatJid: string): AgentDefinition | undefined {
  const agentId = getAgentIdForChat(chatJid);
  return agentId ? agents[agentId] : undefined;
}

export function getWorkspaceFolderForAgent(agentId: string): string | undefined {
  return agents[agentId]?.workspaceFolder;
}

export function getAgentWorkspaceFolder(agentId: string): string | undefined {
  return getWorkspaceFolderForAgent(agentId);
}

export function getChatJidsForAgent(agentId: string): string[] {
  return Object.entries(chatAgentBindings)
    .filter(([, boundAgentId]) => boundAgentId === agentId)
    .map(([chatJid]) => chatJid);
}

export function getLastAgentTimestamp(): Record<string, string> {
  return lastAgentTimestamp;
}

export function setLastAgentTimestampFor(chatJid: string, ts: string): void {
  lastAgentTimestamp[chatJid] = ts;
}

export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = Object.fromEntries(
    Object.entries(getAllRegisteredGroups()).map(([jid, group]) => [
      jid,
      normalizeRegisteredGroup(group),
    ]),
  );
  agents = getAllAgents();
  chatAgentBindings = getAllDefaultChatAgentBindings();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!chatAgentBindings[jid]) {
      const workspaceFolder = getWorkspaceFolder(group);
      const agentId = ensureDefaultAgentForWorkspace(workspaceFolder, group.added_at);
      setDefaultChatAgentBinding(jid, agentId, group.added_at);
      chatAgentBindings[jid] = agentId;
    }
    ensureDefaultThreadForChat(jid);
  }
  agents = getAllAgents();

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentCount: Object.keys(agents).length,
    },
    'State loaded',
  );
}

export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  const normalized = normalizeRegisteredGroup(group);
  registeredGroups[jid] = normalized;
  setRegisteredGroup(jid, normalized);
  const workspaceFolder = getWorkspaceFolder(normalized);
  ensureGroupDir(workspaceFolder);
  const agentId = ensureDefaultAgentForWorkspace(workspaceFolder, normalized.added_at);
  const agent = getAllAgents()[agentId];
  if (agent) agents[agentId] = agent;
  setDefaultChatAgentBinding(jid, agentId, normalized.added_at);
  chatAgentBindings[jid] = agentId;
  ensureDefaultThreadForChat(jid);
  logger.info(
    {
      jid,
      name: normalized.name,
      folder: normalized.folder,
      workspaceFolder,
      agentId,
    },
    'Group registered',
  );
}

export function upsertRegisteredGroupDefinition(jid: string, group: RegisteredGroup): void {
  const normalized = normalizeRegisteredGroup(group);
  registeredGroups[jid] = normalized;
  setRegisteredGroup(jid, normalized);
}

export function getWorkspaceFolderForChat(chatJid: string): string | undefined {
  const group = registeredGroups[chatJid];
  return group ? getWorkspaceFolder(group) : undefined;
}

export function getChatJidsForWorkspace(workspaceFolder: string): string[] {
  return getWorkspaceChatJids(registeredGroups, workspaceFolder);
}

export function listWorkspaceFolders(): string[] {
  const folders = new Set<string>();
  for (const group of Object.values(registeredGroups)) {
    folders.add(getWorkspaceFolder(group));
  }
  for (const agent of Object.values(agents)) {
    folders.add(agent.workspaceFolder);
  }
  return Array.from(folders).sort();
}

export function ensureDefaultThreadForChat(chatJid: string): ChatThreadDefinition | undefined {
  const group = registeredGroups[chatJid];
  const agentId = chatAgentBindings[chatJid];
  if (!group || !agentId) return undefined;

  const existing = getChatThreads(chatJid);
  const currentWorkspace = getWorkspaceFolder(group);
  const current = existing.find((thread) => thread.agentId === agentId && thread.workspaceFolder === currentWorkspace);
  if (current) return current;

  const createdAt = group.added_at;
  const thread: ChatThreadDefinition = {
    id: `default-${Buffer.from(chatJid).toString('base64url').slice(0, 16)}`,
    chatJid,
    title: group.name,
    workspaceFolder: currentWorkspace,
    agentId,
    createdAt,
    updatedAt: createdAt,
    archived: false,
  };
  upsertChatThread(thread);
  return thread;
}

export function listThreadsForChat(chatJid: string): ChatThreadDefinition[] {
  ensureDefaultThreadForChat(chatJid);
  return getChatThreads(chatJid);
}

export function getCurrentThreadForChat(chatJid: string): ChatThreadDefinition | undefined {
  const activeAgentId = getAgentIdForChat(chatJid);
  const activeWorkspace = getWorkspaceFolderForChat(chatJid);
  const threads = listThreadsForChat(chatJid);
  return threads.find((thread) => (
    thread.agentId === activeAgentId && thread.workspaceFolder === activeWorkspace
  )) || threads[0];
}

export function createThreadForChat(chatJid: string, title: string): ChatThreadDefinition | undefined {
  const group = registeredGroups[chatJid];
  if (!group) return undefined;
  const now = new Date().toISOString();
  const token = Math.random().toString(36).slice(2, 10);
  const workspaceFolder = `thread-${token}`;
  ensureGroupDir(workspaceFolder);
  const agentId = ensureDefaultAgentForWorkspace(workspaceFolder, now);
  const freshAgent = getAllAgents()[agentId];
  if (freshAgent) {
    agents[agentId] = freshAgent;
  }
  const thread: ChatThreadDefinition = {
    id: `thread-${token}`,
    chatJid,
    title,
    workspaceFolder,
    agentId,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  upsertChatThread(thread);
  return thread;
}

export function renameThreadForChat(
  chatJid: string,
  threadId: string,
  title: string,
): ChatThreadDefinition | undefined {
  const thread = listThreadsForChat(chatJid).find((candidate) => candidate.id === threadId);
  if (!thread) return undefined;
  const updated = {
    ...thread,
    title,
    updatedAt: new Date().toISOString(),
  };
  upsertChatThread(updated);
  return updated;
}

export function switchChatToThread(chatJid: string, threadId: string): ChatThreadDefinition | undefined {
  const thread = listThreadsForChat(chatJid).find((candidate) => candidate.id === threadId);
  if (!thread) return undefined;

  const binding = bindChatToWorkspace(chatJid, thread.workspaceFolder);
  if (!binding) return undefined;
  bindChatToAgent(chatJid, thread.agentId);

  const updated = {
    ...thread,
    updatedAt: new Date().toISOString(),
  };
  upsertChatThread(updated);
  return updated;
}

export function archiveThreadForChat(
  chatJid: string,
  threadId: string,
): { archivedThread: ChatThreadDefinition; switchedTo?: ChatThreadDefinition } | undefined {
  const threads = listThreadsForChat(chatJid);
  const target = threads.find((candidate) => candidate.id === threadId);
  if (!target) return undefined;
  const activeAgentId = getAgentIdForChat(chatJid);
  const activeWorkspace = getWorkspaceFolderForChat(chatJid);
  const wasCurrent = target.agentId === activeAgentId && target.workspaceFolder === activeWorkspace;
  archiveChatThread(threadId);

  if (!wasCurrent) {
    return { archivedThread: target };
  }

  const fallback = threads.find((candidate) => candidate.id !== threadId);
  if (!fallback) {
    return { archivedThread: target };
  }
  const switchedTo = switchChatToThread(chatJid, fallback.id);
  return { archivedThread: target, switchedTo };
}

export function touchCurrentThreadForChat(chatJid: string): ChatThreadDefinition | undefined {
  const thread = getCurrentThreadForChat(chatJid);
  if (!thread) return undefined;
  const updated = {
    ...thread,
    updatedAt: new Date().toISOString(),
  };
  upsertChatThread(updated);
  return updated;
}

export function upsertAgentDefinition(agent: AgentDefinition): void {
  upsertAgent(agent);
  agents[agent.id] = agent;
}

export function bindChatToAgent(chatJid: string, agentId: string): void {
  const group = registeredGroups[chatJid];
  const agent = agents[agentId];
  if (!group || !agent) return;

  setDefaultChatAgentBinding(chatJid, agentId, new Date().toISOString());
  chatAgentBindings[chatJid] = agentId;
}

export function bindChatToWorkspace(
  chatJid: string,
  workspaceFolder: string,
): { workspaceFolder: string; agentId: string } | undefined {
  const group = registeredGroups[chatJid];
  if (!group) return undefined;

  const updated = normalizeRegisteredGroup({
    ...group,
    workspaceFolder,
  });
  registeredGroups[chatJid] = updated;
  setRegisteredGroup(chatJid, updated);
  ensureGroupDir(workspaceFolder);

  const agentId = ensureDefaultAgentForWorkspace(workspaceFolder, updated.added_at);
  const freshAgent = getAllAgents()[agentId];
  if (freshAgent) {
    agents[agentId] = freshAgent;
  }
  bindChatToAgent(chatJid, agentId);
  ensureDefaultThreadForChat(chatJid);
  return { workspaceFolder, agentId };
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}
