import WebSocket, { RawData } from 'ws';

import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const QQ_JID_SUFFIX_GROUP = '@qq.group';
const QQ_JID_SUFFIX_USER = '@qq.user';
const QQ_ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const QQ_GROUP_AND_C2C_INTENT = 1 << 25;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
const SEEN_EVENT_TTL_MS = 10 * 60 * 1000;

type QQDispatchType = 'READY' | 'C2C_MESSAGE_CREATE' | 'GROUP_AT_MESSAGE_CREATE';

interface QQAccessTokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

interface QQGatewayBotResponse {
  url: string;
  shards?: number;
}

interface QQAttachment {
  content_type?: string;
  filename?: string;
}

interface QQC2CEvent {
  id: string;
  content?: string;
  timestamp?: string;
  author?: {
    user_openid?: string;
  };
  attachments?: QQAttachment[];
}

interface QQGroupAtEvent {
  id: string;
  content?: string;
  timestamp?: string;
  group_openid?: string;
  author?: {
    member_openid?: string;
  };
  attachments?: QQAttachment[];
}

interface QQReadyEvent {
  session_id?: string;
}

interface QQGatewayPayload<T = unknown> {
  id?: string;
  op: number;
  d?: T;
  s?: number;
  t?: QQDispatchType;
}

export interface QQChannelOpts {
  appId: string;
  clientSecret: string;
  sandbox?: boolean;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

export function buildQqChatJid(openId: string, kind: 'group' | 'user'): string {
  return `${openId}${kind === 'group' ? QQ_JID_SUFFIX_GROUP : QQ_JID_SUFFIX_USER}`;
}

export function parseQqMessageContent(content?: string, attachments?: QQAttachment[]): string | null {
  const text = content?.trim();
  if (text) return text;

  const firstAttachment = attachments?.[0];
  if (!firstAttachment) return null;

  const contentType = firstAttachment.content_type || '';
  if (contentType.startsWith('image/')) return '[image]';
  if (contentType.startsWith('video/')) return '[video]';
  if (contentType === 'voice') return '[voice]';
  if (contentType === 'file') return firstAttachment.filename ? `[file: ${firstAttachment.filename}]` : '[file]';
  return '[attachment]';
}

function apiBase(sandbox: boolean | undefined): string {
  return sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
}

function toIsoTimestamp(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function buildDirectChatName(userOpenId: string): string {
  return `QQ DM ${userOpenId}`;
}

function buildGroupChatName(groupOpenId: string): string {
  return `QQ Group ${groupOpenId.slice(-8)}`;
}

function textPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export class QQChannel implements Channel {
  name = 'qq';
  prefixAssistantName = false;

  private readonly opts: QQChannelOpts;
  private ws?: WebSocket;
  private connected = false;
  private shuttingDown = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connectPromise?: Promise<void>;
  private lastSequence: number | null = null;
  private sessionId?: string;
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private readonly seenEventIds = new Map<string, number>();
  private readonly seenEventGcTimer: NodeJS.Timeout;

  constructor(opts: QQChannelOpts) {
    this.opts = opts;
    this.seenEventGcTimer = setInterval(() => this.pruneSeenEvents(), 60_000);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.shuttingDown = false;
    this.connectPromise = this.connectOnce().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(QQ_JID_SUFFIX_GROUP) || jid.endsWith(QQ_JID_SUFFIX_USER);
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;
    clearInterval(this.seenEventGcTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    this.lastSequence = null;
    this.sessionId = undefined;

    if (!this.ws) return;
    const ws = this.ws;
    this.ws = undefined;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(() => resolve(), 2_000);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const payload = { content: text, msg_type: 0 };

    if (jid.endsWith(QQ_JID_SUFFIX_USER)) {
      const openId = jid.slice(0, -QQ_JID_SUFFIX_USER.length);
      await this.apiRequest(`/v2/users/${openId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      logger.info({ jid, length: text.length }, 'QQ message sent');
      return;
    }

    if (jid.endsWith(QQ_JID_SUFFIX_GROUP)) {
      const groupOpenId = jid.slice(0, -QQ_JID_SUFFIX_GROUP.length);
      await this.apiRequest(`/v2/groups/${groupOpenId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      logger.info({ jid, length: text.length }, 'QQ message sent');
      return;
    }

    logger.warn({ jid }, 'Invalid QQ JID, message not sent');
  }

  private async connectOnce(): Promise<void> {
    const gateway = await this.getGateway();
    logger.info({ url: gateway.url, sandbox: !!this.opts.sandbox }, 'Connecting to QQ gateway');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(gateway.url);
      this.ws = ws;
      this.lastSequence = null;
      this.sessionId = undefined;

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.on('message', (data) => {
        void this.handleSocketMessage(data, settleResolve, settleReject);
      });

      ws.once('error', (err) => {
        logger.error({ err }, 'QQ WebSocket error');
        this.connected = false;
        if (!settled) {
          settleReject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!this.shuttingDown) this.scheduleReconnect('error');
      });

      ws.once('close', (code, reason) => {
        this.connected = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        this.ws = undefined;

        const reasonText = reason.toString() || 'no reason';
        if (!settled) {
          settleReject(new Error(`QQ WebSocket closed before ready (code=${code}, reason=${reasonText})`));
          return;
        }
        if (!this.shuttingDown) this.scheduleReconnect(`close code=${code} reason=${reasonText}`);
      });
    });
  }

  private async handleSocketMessage(
    raw: RawData,
    onReady: () => void,
    onFatal: (error: Error) => void,
  ): Promise<void> {
    let payload: QQGatewayPayload;
    try {
      payload = JSON.parse(raw.toString()) as QQGatewayPayload;
    } catch (err) {
      logger.warn({ err }, 'Failed to parse QQ gateway payload');
      return;
    }

    if (typeof payload.s === 'number') this.lastSequence = payload.s;

    switch (payload.op) {
      case 10: {
        const heartbeatInterval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval || 45_000);
        this.startHeartbeat(heartbeatInterval);
        try {
          await this.sendIdentify();
        } catch (err) {
          onFatal(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      case 11:
        return;
      case 7:
        logger.warn('QQ gateway requested reconnect');
        this.ws?.close();
        return;
      case 9:
        logger.warn('QQ gateway reported invalid session');
        this.ws?.close();
        return;
      case 0:
        break;
      default:
        return;
    }

    if (payload.t === 'READY') {
      this.sessionId = (payload.d as QQReadyEvent | undefined)?.session_id;
      this.connected = true;
      logger.info('Connected to QQ (websocket)');
      onReady();
      return;
    }

    if (payload.t === 'C2C_MESSAGE_CREATE') {
      await this.handleDirectMessage(payload.d as QQC2CEvent);
      return;
    }

    if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
      await this.handleGroupAtMessage(payload.d as QQGroupAtEvent);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
    }, intervalMs);
  }

  private async sendIdentify(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('QQ gateway socket is not open');
    }
    const accessToken = await this.getAccessToken();
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${accessToken}`,
        intents: QQ_GROUP_AND_C2C_INTENT,
        shard: [0, 1],
        properties: {
          $os: 'linux',
          $browser: 'bioclaw',
          $device: 'bioclaw',
        },
      },
    }));
  }

  private async handleDirectMessage(event: QQC2CEvent): Promise<void> {
    if (!event.id || this.isDuplicateEvent(event.id)) return;

    const sender = event.author?.user_openid;
    if (!sender) return;

    const content = parseQqMessageContent(event.content, event.attachments);
    if (!content) return;

    const chatJid = buildQqChatJid(sender, 'user');
    const timestamp = toIsoTimestamp(event.timestamp);
    const chatName = buildDirectChatName(sender);

    this.opts.onChatMetadata(chatJid, timestamp, chatName);
    this.ensureRegistered(chatJid, chatName);
    if (!this.opts.registeredGroups()[chatJid]) {
      logger.info({ chatJid }, 'QQ direct message from unregistered conversation, ignored');
      return;
    }

    const message: NewMessage = {
      id: event.id,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content,
      timestamp,
      is_from_me: false,
    };
    this.opts.onMessage(chatJid, message);
    logger.info({ chatJid, sender, preview: textPreview(content) }, 'QQ direct message received');
  }

  private async handleGroupAtMessage(event: QQGroupAtEvent): Promise<void> {
    if (!event.id || this.isDuplicateEvent(event.id)) return;

    const groupOpenId = event.group_openid;
    const sender = event.author?.member_openid;
    if (!groupOpenId || !sender) return;

    const content = parseQqMessageContent(event.content, event.attachments);
    if (!content) return;

    const chatJid = buildQqChatJid(groupOpenId, 'group');
    const timestamp = toIsoTimestamp(event.timestamp);
    const chatName = buildGroupChatName(groupOpenId);

    this.opts.onChatMetadata(chatJid, timestamp, chatName);
    this.ensureRegistered(chatJid, chatName);
    if (!this.opts.registeredGroups()[chatJid]) {
      logger.info({ chatJid }, 'QQ group message from unregistered conversation, ignored');
      return;
    }

    const message: NewMessage = {
      id: event.id,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content,
      timestamp,
      is_from_me: false,
    };
    this.opts.onMessage(chatJid, message);
    logger.info({ chatJid, sender, preview: textPreview(content) }, 'QQ group message received');
  }

  private ensureRegistered(chatJid: string, chatName: string): void {
    const groups = this.opts.registeredGroups();
    if (groups[chatJid] || !this.opts.autoRegister) return;
    this.opts.autoRegister(chatJid, chatName, 'qq');
  }

  private async getGateway(): Promise<QQGatewayBotResponse> {
    return this.apiRequest<QQGatewayBotResponse>('/gateway/bot', { method: 'GET' });
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const response = await fetch(QQ_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.opts.appId, clientSecret: this.opts.clientSecret }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get QQ access token (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = await response.json() as QQAccessTokenResponse;
    if (!data.access_token) {
      throw new Error('QQ access token response did not include access_token');
    }

    const expiresInSeconds = Number(data.expires_in || 7200);
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(1_000, expiresInSeconds * 1000 - ACCESS_TOKEN_SKEW_MS);
    return this.accessToken;
  }

  private async apiRequest<T>(path: string, init: RequestInit, retry = true): Promise<T> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `QQBot ${token}`);
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await fetch(`${apiBase(this.opts.sandbox)}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401 && retry) {
      await this.getAccessToken(true);
      return this.apiRequest<T>(path, init, false);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`QQ API ${init.method || 'GET'} ${path} failed (${response.status}): ${body.slice(0, 200)}`);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private scheduleReconnect(reason: string): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    logger.warn({ reason }, 'Scheduling QQ reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err) => {
        logger.error({ err }, 'QQ reconnect failed');
        this.scheduleReconnect('retry-after-failure');
      });
    }, RECONNECT_DELAY_MS);
  }

  private isDuplicateEvent(eventId: string): boolean {
    const now = Date.now();
    const seenAt = this.seenEventIds.get(eventId);
    this.seenEventIds.set(eventId, now);
    return seenAt !== undefined && now - seenAt < SEEN_EVENT_TTL_MS;
  }

  private pruneSeenEvents(): void {
    const cutoff = Date.now() - SEEN_EVENT_TTL_MS;
    for (const [eventId, seenAt] of this.seenEventIds.entries()) {
      if (seenAt < cutoff) this.seenEventIds.delete(eventId);
    }
  }
}
