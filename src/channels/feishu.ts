import http from 'http';

import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const FEISHU_JID_SUFFIX_GROUP = '@feishu.group';
const FEISHU_JID_SUFFIX_USER = '@feishu.user';
const SEEN_EVENT_TTL_MS = 10 * 60 * 1000;

type FeishuMessageEvent = Parameters<NonNullable<Lark.EventHandles['im.message.receive_v1']>>[0];

export interface FeishuChannelOpts {
  appId: string;
  appSecret: string;
  connectionMode: 'websocket' | 'webhook';
  verificationToken?: string;
  encryptKey?: string;
  host?: string;
  port?: number;
  path?: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

export function buildFeishuChatJid(chatId: string, chatType: string): string {
  const suffix = chatType === 'p2p' ? FEISHU_JID_SUFFIX_USER : FEISHU_JID_SUFFIX_GROUP;
  return `${chatId}${suffix}`;
}

export function parseFeishuMessageContent(messageType: string, rawContent: string): string | null {
  if (messageType === 'text') {
    try {
      const parsed = JSON.parse(rawContent) as { text?: string };
      const text = parsed.text?.trim();
      return text || null;
    } catch {
      const text = rawContent.trim();
      return text || null;
    }
  }

  const placeholders: Record<string, string> = {
    image: '[image]',
    audio: '[audio]',
    media: '[media]',
    file: '[file]',
    sticker: '[sticker]',
    post: '[post]',
    interactive: '[interactive]',
    share_chat: '[shared chat]',
    share_user: '[shared user]',
    system: '[system message]',
  };

  const placeholder = placeholders[messageType];
  if (placeholder) return placeholder;

  const text = rawContent.trim();
  if (text) return text;
  return `[${messageType}]`;
}

function toIsoTimestamp(ms: string): string {
  const value = Number(ms);
  if (Number.isNaN(value)) return new Date().toISOString();
  return new Date(value).toISOString();
}

function senderIdFor(event: FeishuMessageEvent): string {
  return event.sender.sender_id?.open_id
    || event.sender.sender_id?.user_id
    || event.sender.sender_id?.union_id
    || 'unknown';
}

function buildChatName(event: FeishuMessageEvent): string {
  if (event.message.chat_type === 'p2p') {
    return `Feishu DM ${senderIdFor(event)}`;
  }
  return `Feishu Group ${event.message.chat_id.slice(-8)}`;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFeishuMentionTokens(event: FeishuMessageEvent, content: string): string {
  let normalized = content;
  const mentions = event.message.mentions as Array<{ key?: string; name?: string }> | undefined;

  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      const key = mention.key?.trim();
      if (!key) continue;
      const mentionName = mention.name?.trim() || ASSISTANT_NAME;
      normalized = normalized.replace(
        new RegExp(`@${escapeRegexLiteral(key)}\\b`, 'g'),
        `@${mentionName}`,
      );
    }
  }

  // In group chats, Feishu commonly emits mention placeholders like "@_user_1".
  // Convert the leading placeholder to @AssistantName so trigger gating can match.
  if (event.message.chat_type !== 'p2p') {
    normalized = normalized.replace(/^(\s*)@_[^\s]+/, `$1@${ASSISTANT_NAME}`);
  }

  return normalized;
}

export class FeishuChannel implements Channel {
  name = 'feishu';
  prefixAssistantName = false;

  private readonly opts: FeishuChannelOpts;
  private readonly client: Lark.Client;
  private readonly dispatcher: Lark.EventDispatcher;
  private wsClient?: Lark.WSClient;
  private server?: http.Server;
  private connected = false;
  private readonly seenEventIds = new Map<string, number>();
  private readonly seenEventGcTimer: ReturnType<typeof setInterval>;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.dispatcher = new Lark.EventDispatcher({
      verificationToken: opts.verificationToken,
      encryptKey: opts.encryptKey,
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      'im.message.receive_v1': async (data) => {
        await this.handleMessageEvent(data);
      },
    });
    this.seenEventGcTimer = setInterval(() => this.pruneSeenEvents(), 60_000);
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.opts.connectionMode === 'webhook') {
      await this.startWebhookServer();
      this.connected = true;
      logger.info(
        {
          host: this.opts.host ?? '0.0.0.0',
          port: this.opts.port ?? 8080,
          path: this.opts.path ?? '/feishu/events',
        },
        'Connected to Feishu (webhook)',
      );
      return;
    }

    if (this.opts.connectionMode !== 'websocket') {
      throw new Error(`Unsupported Feishu connection mode: ${this.opts.connectionMode}`);
    }

    this.wsClient = new Lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      autoReconnect: true,
      loggerLevel: Lark.LoggerLevel.info,
    });
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    this.connected = true;
    logger.info('Connected to Feishu (websocket)');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(FEISHU_JID_SUFFIX_GROUP) || jid.endsWith(FEISHU_JID_SUFFIX_USER);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    clearInterval(this.seenEventGcTimer);
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = undefined;
    }
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = this.toChatId(jid);
    if (!chatId) {
      logger.warn({ jid }, 'Invalid Feishu JID, message not sent');
      return;
    }

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    logger.info({ jid, length: text.length }, 'Feishu message sent');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu bot typing indicator is not implemented in this channel.
  }

  private async startWebhookServer(): Promise<void> {
    const handler = Lark.adaptDefault(this.opts.path ?? '/feishu/events', this.dispatcher);
    this.server = http.createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.opts.port ?? 8080, this.opts.host ?? '0.0.0.0', () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
    if (this.isDuplicateEvent(event.event_id)) return;
    if (event.sender.sender_type !== 'user') return;

    const rawContent = parseFeishuMessageContent(event.message.message_type, event.message.content);
    const content = rawContent
      ? normalizeFeishuMentionTokens(event, rawContent)
      : rawContent;
    if (!content) return;

    const chatJid = buildFeishuChatJid(event.message.chat_id, event.message.chat_type);
    const timestamp = toIsoTimestamp(event.message.create_time);
    const sender = senderIdFor(event);
    const senderName = sender;

    this.opts.onChatMetadata(chatJid, timestamp, buildChatName(event));

    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      this.opts.autoRegister(chatJid, buildChatName(event), 'feishu');
      groups = this.opts.registeredGroups();
    }

    if (!groups[chatJid]) {
      logger.info({ chatJid }, 'Feishu message from unregistered conversation, ignored');
      return;
    }

    const message: NewMessage = {
      id: event.message.message_id,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    };
    this.opts.onMessage(chatJid, message);
    logger.info(
      { chatJid, sender, messageType: event.message.message_type, preview: content.slice(0, 80) },
      'Feishu message received',
    );
  }

  private toChatId(jid: string): string | null {
    if (jid.endsWith(FEISHU_JID_SUFFIX_GROUP)) {
      return jid.slice(0, -FEISHU_JID_SUFFIX_GROUP.length);
    }
    if (jid.endsWith(FEISHU_JID_SUFFIX_USER)) {
      return jid.slice(0, -FEISHU_JID_SUFFIX_USER.length);
    }
    return null;
  }

  private isDuplicateEvent(eventId?: string): boolean {
    if (!eventId) return false;
    const now = Date.now();
    const seenAt = this.seenEventIds.get(eventId);
    if (seenAt && now - seenAt < SEEN_EVENT_TTL_MS) {
      logger.debug({ eventId }, 'Skipping duplicate Feishu event');
      return true;
    }
    this.seenEventIds.set(eventId, now);
    return false;
  }

  private pruneSeenEvents(): void {
    const cutoff = Date.now() - SEEN_EVENT_TTL_MS;
    for (const [eventId, seenAt] of this.seenEventIds) {
      if (seenAt < cutoff) this.seenEventIds.delete(eventId);
    }
  }
}
