import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { WSClient, type WsFrame, type BaseMessage, type TextMessage, type ImageMessage, type VoiceMessage, type MixedMessage } from '@wecom/aibot-node-sdk';

import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const WECOM_JID_SUFFIX_GROUP = '@wecom.group';
const WECOM_JID_SUFFIX_USER = '@wecom.user';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface AgentCredentials {
  corpId: string;
  corpSecret: string;
  agentId: string;
}

export interface WeComChannelOpts {
  botId: string;
  secret: string;
  agent?: AgentCredentials;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

/**
 * Tracks an inbound WeCom message frame so we can reply in-context
 * using the original req_id (required by the WeCom API).
 */
interface PendingReply {
  frame: WsFrame<BaseMessage>;
  timestamp: number;
}


export class WeComChannel implements Channel {
  name = 'wecom';
  prefixAssistantName = false;

  private client!: WSClient;
  private connected = false;
  private opts: WeComChannelOpts;
  private pendingReplies = new Map<string, PendingReply[]>();
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private agentToken = '';
  private agentTokenExpiresAt = 0;

  constructor(opts: WeComChannelOpts) {
    this.opts = opts;
    setInterval(() => this.cleanStalePendingReplies(), 5 * 60 * 1000);
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WeCom connection timeout')), 30_000);

      this.client = new WSClient({
        botId: this.opts.botId,
        secret: this.opts.secret,
        maxReconnectAttempts: -1,
        logger: {
          debug: (msg, ...a) => logger.info({ wecom: true, level: 'debug' }, msg, ...a),
          info: (msg, ...a) => logger.info({ wecom: true }, msg, ...a),
          warn: (msg, ...a) => logger.warn({ wecom: true }, msg, ...a),
          error: (msg, ...a) => logger.error({ wecom: true }, msg, ...a),
        },
      });

      this.client.on('authenticated', () => {
        this.connected = true;
        logger.info('Connected to WeCom');
        clearTimeout(timeout);
        this.flushOutgoingQueue().catch(err =>
          logger.error({ err }, 'Failed to flush WeCom outgoing queue'),
        );
        resolve();
      });

      this.client.on('disconnected', (reason) => {
        this.connected = false;
        logger.warn({ reason }, 'WeCom disconnected');
      });

      this.client.on('reconnecting', (attempt) => {
        logger.info({ attempt }, 'WeCom reconnecting');
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'WeCom error');
      });

      this.setupMessageHandlers();
      this.client.connect();
    });
  }

  private setupMessageHandlers(): void {
    this.client.on('message', (frame: WsFrame<BaseMessage>) => {
      logger.info(
        { cmd: frame.cmd, msgtype: frame.body?.msgtype, chattype: frame.body?.chattype, reqId: frame.headers?.req_id },
        'WeCom raw message event',
      );
    });

    this.client.on('message.text', (frame: WsFrame<TextMessage>) => {
      this.handleInbound(frame, frame.body!.text.content);
    });

    this.client.on('message.voice', (frame: WsFrame<VoiceMessage>) => {
      this.handleInbound(frame, frame.body!.voice.content);
    });

    this.client.on('message.image', (frame: WsFrame<ImageMessage>) => {
      this.handleInbound(frame, '[image]');
    });

    this.client.on('message.mixed', (frame: WsFrame<MixedMessage>) => {
      const parts = frame.body!.mixed.msg_item
        .map(item => item.msgtype === 'text' ? item.text?.content : '[image]')
        .filter(Boolean);
      this.handleInbound(frame, parts.join(' '));
    });
  }

  private handleInbound(frame: WsFrame<BaseMessage>, content: string): void {
    const body = frame.body!;
    const chatJid = this.toChatJid(body);
    const timestamp = new Date(
      body.create_time ? body.create_time * 1000 : Date.now(),
    ).toISOString();

    logger.info(
      { chatJid, sender: body.from.userid, chattype: body.chattype, contentPreview: content.slice(0, 80) },
      'WeCom message received',
    );

    const q = this.pendingReplies.get(chatJid) ?? [];
    q.push({ frame, timestamp: Date.now() });
    this.pendingReplies.set(chatJid, q);

    this.opts.onChatMetadata(chatJid, timestamp);

    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      const chatName = body.chattype === 'group'
        ? `WeCom Group ${body.chatid || chatJid}`
        : `WeCom DM ${body.from.userid}`;
      this.opts.autoRegister(chatJid, chatName, 'wecom');
      groups = this.opts.registeredGroups();
    }

    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: body.msgid,
        chat_jid: chatJid,
        sender: body.from.userid,
        sender_name: body.from.userid,
        content,
        timestamp,
        is_from_me: false,
      });
    } else {
      logger.info({ chatJid }, 'WeCom message from unregistered chat, freeing slot');
      this.ackAndFreeSlot(chatJid).catch(err =>
        logger.error({ chatJid, err }, 'Failed to free WeCom message slot'),
      );
    }
  }

  /**
   * Send a minimal finish-reply to free the WeCom concurrent-message slot
   * (max 3 per user-bot pair). Without this, unreplied messages block
   * all future message pushes from the server.
   */
  private async ackAndFreeSlot(chatJid: string): Promise<void> {
    const q = this.pendingReplies.get(chatJid);
    const pending = q?.shift();
    if (!pending) return;
    try {
      const streamId = crypto.randomUUID();
      await this.client.replyStream(pending.frame, streamId, ' ', true);
    } finally {
      if (!q || q.length === 0) this.pendingReplies.delete(chatJid);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'WeCom disconnected, message queued');
      return;
    }

    try {
      const q = this.pendingReplies.get(jid);
      const pending = q?.shift();
      if (pending) {
        const streamId = crypto.randomUUID();
        await this.client.replyStream(pending.frame, streamId, text, true);
        if (!q || q.length === 0) this.pendingReplies.delete(jid);
      } else {
        const chatid = this.toWeComId(jid);
        await this.client.sendMessage(chatid, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
      }
      logger.info({ jid, length: text.length }, 'WeCom message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'WeCom send failed, queued');
    }
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const imageBuffer = fs.readFileSync(imagePath);

    // Agent API is the reliable way to send images (requires IP whitelist on server)
    if (this.opts.agent) {
      try {
        await this.agentSendImage(jid, imageBuffer, path.basename(imagePath), caption);
        return;
      } catch (err) {
        logger.warn({ jid, err }, 'Agent API image send failed, image skipped');
      }
    }

    if (caption) {
      logger.info({ jid }, 'Image not sent (Agent API unavailable), sending caption as text');
      await this.sendMessage(jid, `[图片: ${path.basename(imagePath)}]\n${caption}`);
    } else {
      logger.warn({ jid, imagePath }, 'Image not sent (Agent API not configured or IP not whitelisted)');
    }
  }

  // ── Agent API (self-built app) for media delivery ──

  private async getAgentToken(): Promise<string> {
    const agent = this.opts.agent;
    if (!agent) throw new Error('Agent API not configured');

    if (this.agentToken && this.agentTokenExpiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return this.agentToken;
    }

    const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(agent.corpId)}&corpsecret=${encodeURIComponent(agent.corpSecret)}`;
    const res = await fetch(url);
    const json = await res.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!json.access_token) {
      throw new Error(`WeCom gettoken failed: ${json.errcode} ${json.errmsg}`);
    }
    this.agentToken = json.access_token;
    this.agentTokenExpiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
    return this.agentToken;
  }

  private async agentUploadMedia(buffer: Buffer, filename: string, type: 'image' | 'file'): Promise<string> {
    const token = await this.getAgentToken();
    const url = `${WECOM_API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`;

    const boundary = `----boundary${crypto.randomBytes(16).toString('hex')}`;
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const ctMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
    const contentType = ctMap[ext] || 'application/octet-stream';

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"; filelength=${buffer.length}\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const json = await res.json() as { media_id?: string; errcode?: number; errmsg?: string };
    if (!json.media_id) {
      throw new Error(`WeCom media upload failed: ${json.errcode} ${json.errmsg}`);
    }
    return json.media_id;
  }

  private async agentSendImage(jid: string, buffer: Buffer, filename: string, caption?: string): Promise<void> {
    const agent = this.opts.agent!;
    const mediaId = await this.agentUploadMedia(buffer, filename, 'image');
    const token = await this.getAgentToken();

    const isGroup = jid.endsWith(WECOM_JID_SUFFIX_GROUP);
    const wecomId = this.toWeComId(jid);

    if (isGroup) {
      const url = `${WECOM_API_BASE}/appchat/send?access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatid: wecomId, msgtype: 'image', image: { media_id: mediaId } }),
      });
      const json = await res.json() as { errcode?: number; errmsg?: string };
      if (json.errcode !== 0) throw new Error(`appchat/send image failed: ${json.errcode} ${json.errmsg}`);
    } else {
      const url = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: wecomId,
          msgtype: 'image',
          agentid: Number(agent.agentId),
          image: { media_id: mediaId },
        }),
      });
      const json = await res.json() as { errcode?: number; errmsg?: string };
      if (json.errcode !== 0) throw new Error(`message/send image failed: ${json.errcode} ${json.errmsg}`);
    }

    if (caption) {
      await this.sendMessage(jid, caption);
    }
    logger.info({ jid, filename }, 'WeCom image sent via Agent API');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(WECOM_JID_SUFFIX_GROUP) || jid.endsWith(WECOM_JID_SUFFIX_USER);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.disconnect();
  }

  private toChatJid(body: BaseMessage): string {
    if (body.chattype === 'group' && body.chatid) {
      return `${body.chatid}${WECOM_JID_SUFFIX_GROUP}`;
    }
    return `${body.from.userid}${WECOM_JID_SUFFIX_USER}`;
  }

  private toWeComId(jid: string): string {
    return jid.replace(WECOM_JID_SUFFIX_GROUP, '').replace(WECOM_JID_SUFFIX_USER, '');
  }

  private cleanStalePendingReplies(): void {
    const now = Date.now();
    const maxAge = 20 * 60 * 1000; // 20 minutes
    for (const [jid, q] of this.pendingReplies) {
      const fresh = q.filter(p => now - p.timestamp <= maxAge);
      if (fresh.length === 0) this.pendingReplies.delete(jid);
      else if (fresh.length !== q.length) this.pendingReplies.set(jid, fresh);
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing WeCom outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
