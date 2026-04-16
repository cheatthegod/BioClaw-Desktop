/**
 * WeChat Personal Account Channel
 *
 * Uses weixin-agent-sdk (https://github.com/wong2/weixin-agent-sdk), a community
 * wrapper around Tencent's OpenClaw WeChat channel (@tencent-weixin/openclaw-weixin).
 * QR-code login, long-polling for messages.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { login, start } from 'weixin-agent-sdk';
import type { Agent as WxAgent, ChatRequest, ChatResponse } from 'weixin-agent-sdk';

import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const WECHAT_JID_SUFFIX_GROUP = '@wechat.group';
const WECHAT_JID_SUFFIX_USER = '@wechat.user';

export interface WeChatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

// Buffer window: collect all sends within this period, then combine into one response
const SEND_BUFFER_MS = 2000;

interface PendingResponse {
  resolve: (resp: ChatResponse) => void;
  texts: string[];
  image?: { url: string };
  timer?: ReturnType<typeof setTimeout>;
}

export class WeChatChannel implements Channel {
  name = 'wechat';
  prefixAssistantName = false;

  private readonly opts: WeChatChannelOpts;
  private connected = false;
  private accountId: string | null = null;
  private abortController: AbortController | null = null;

  // Outbound buffer: conversationId → pending response being assembled
  private readonly pendingResponses = new Map<string, PendingResponse>();

  constructor(opts: WeChatChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    logger.info('WeChat: scanning QR code to login...');
    this.accountId = await login({
      log: (msg) => logger.info({ wechat: true }, msg),
    });
    logger.info({ accountId: this.accountId }, 'WeChat logged in');

    this.connected = true;
    this.abortController = new AbortController();

    // Start long-polling in background (never resolves until abort)
    const agent: WxAgent = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        return this.handleInbound(req);
      },
    };

    start(agent, {
      accountId: this.accountId,
      abortSignal: this.abortController.signal,
      log: (msg) => logger.debug({ wechat: true }, msg),
    }).catch((err) => {
      if (this.connected) {
        logger.error({ err }, 'WeChat polling stopped unexpectedly');
        this.connected = false;
      }
    });

    logger.info('WeChat channel connected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(WECHAT_JID_SUFFIX_GROUP) || jid.endsWith(WECHAT_JID_SUFFIX_USER);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
    // Reject any pending responses
    for (const [, pending] of this.pendingResponses) {
      pending.resolve({ text: undefined });
    }
    this.pendingResponses.clear();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const convId = this.toConversationId(jid);
    if (!convId) {
      logger.warn({ jid }, 'Invalid WeChat JID, message not sent');
      return;
    }

    const pending = this.pendingResponses.get(convId);
    if (!pending) {
      logger.warn(
        { jid, length: text.length },
        'WeChat: no pending request for this conversation, message cannot be sent proactively',
      );
      return;
    }

    pending.texts.push(text);
    this.resetFlushTimer(convId, pending);
    logger.info({ jid, length: text.length }, 'WeChat message buffered');
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const convId = this.toConversationId(jid);
    if (!convId) {
      logger.warn({ jid }, 'Invalid WeChat JID, image not sent');
      return;
    }

    const pending = this.pendingResponses.get(convId);
    if (!pending) {
      logger.warn({ jid }, 'WeChat: no pending request, image cannot be sent proactively');
      return;
    }

    // Copy image to temp dir — IPC deletes the original immediately after this call returns
    let safePath = imagePath;
    if (fs.existsSync(imagePath)) {
      const ext = path.extname(imagePath) || '.png';
      safePath = path.join(os.tmpdir(), `wechat-${Date.now()}${ext}`);
      fs.copyFileSync(imagePath, safePath);
    }

    pending.image = { url: safePath };
    if (caption) pending.texts.push(caption);
    this.resetFlushTimer(convId, pending);
    logger.info({ jid, imagePath, safePath }, 'WeChat image buffered');
  }

  /** Reset (or start) the flush timer — each new send extends the window */
  private resetFlushTimer(convId: string, pending: PendingResponse): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.flushPending(convId), SEND_BUFFER_MS);
  }

  /** Flush all buffered sends into a single ChatResponse */
  private flushPending(convId: string): void {
    const pending = this.pendingResponses.get(convId);
    if (!pending) return;
    this.pendingResponses.delete(convId);

    const resp: ChatResponse = {
      text: pending.texts.length > 0 ? pending.texts.join('\n\n') : undefined,
    };
    if (pending.image) {
      resp.media = { type: 'image', url: pending.image.url };
    }

    pending.resolve(resp);
    logger.info(
      { convId, textParts: pending.texts.length, hasImage: !!pending.image },
      'WeChat response flushed',
    );
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // WeChat does not support typing indicators via this SDK
  }

  // --- Internal ---

  private async handleInbound(req: ChatRequest): Promise<ChatResponse> {
    const isGroup = req.conversationId.includes('@chatroom');
    const suffix = isGroup ? WECHAT_JID_SUFFIX_GROUP : WECHAT_JID_SUFFIX_USER;
    const chatJid = `${req.conversationId}${suffix}`;
    const timestamp = new Date().toISOString();
    const chatName = isGroup
      ? `WeChat Group ${req.conversationId.slice(-8)}`
      : `WeChat DM ${req.conversationId.slice(-8)}`;

    // Handle media attachments
    let content = req.text || '';
    if (req.media) {
      const tag = `[${req.media.type}${req.media.fileName ? `: ${req.media.fileName}` : ''}]`;
      content = content ? `${content}\n${tag}` : tag;
    }

    if (!content) {
      return { text: undefined };
    }

    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    // Auto-register unknown conversations
    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      this.opts.autoRegister(chatJid, chatName, 'wechat');
      groups = this.opts.registeredGroups();
    }

    if (!groups[chatJid]) {
      logger.info({ chatJid }, 'WeChat message from unregistered conversation, ignored');
      return { text: undefined };
    }

    const message: NewMessage = {
      id: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: chatJid,
      sender: req.conversationId,
      sender_name: req.conversationId.slice(-8),
      content,
      timestamp,
      is_from_me: false,
    };

    // Create a promise that the flush timer (or timeout) will resolve
    const responsePromise = new Promise<ChatResponse>((resolve) => {
      this.pendingResponses.set(req.conversationId, { resolve, texts: [] });

      // Timeout: if no response within 5 minutes, return empty
      setTimeout(() => {
        if (this.pendingResponses.has(req.conversationId)) {
          this.pendingResponses.delete(req.conversationId);
          resolve({ text: undefined });
        }
      }, 5 * 60 * 1000);
    });

    // Deliver to orchestrator
    this.opts.onMessage(chatJid, message);
    logger.info(
      { chatJid, preview: content.slice(0, 80), hasMedia: !!req.media },
      'WeChat message received',
    );

    // Wait for orchestrator to call sendMessage/sendImage
    return responsePromise;
  }

  private toConversationId(jid: string): string | null {
    if (jid.endsWith(WECHAT_JID_SUFFIX_GROUP)) {
      return jid.slice(0, -WECHAT_JID_SUFFIX_GROUP.length);
    }
    if (jid.endsWith(WECHAT_JID_SUFFIX_USER)) {
      return jid.slice(0, -WECHAT_JID_SUFFIX_USER.length);
    }
    return null;
  }
}
