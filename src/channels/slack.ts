import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

/** Conversation ID (channel / DM / group DM) — same JID space as Slack API `channel` field */
const SLACK_JID_SUFFIX = '@slack.conv';
const SLACK_TEXT_CHUNK = 35_000;

const IGNORE_MESSAGE_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_archive',
  'channel_unarchive',
  'channel_name',
  'channel_purpose',
  'channel_topic',
  'pinned_item',
  'unpinned_item',
  'ekm_access_denied',
]);

type SlackInboundMessageEvent = {
  type: 'message';
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  files?: Array<{ name?: string; id?: string }>;
};

export interface SlackChannelOpts {
  botToken: string;
  appToken: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';
  prefixAssistantName = false;

  private app: App;
  private connected = false;
  private botUserId = '';
  private opts: SlackChannelOpts;
  private readonly userDisplayCache = new Map<string, string>();
  private readonly channelTitleCache = new Map<string, string>();

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
      ignoreSelf: true,
    });
    this.registerListeners();
  }

  private registerListeners(): void {
    this.app.event('message', async ({ event }) => {
      try {
        await this.handleMessageEvent(event);
      } catch (err) {
        logger.error({ err }, 'Slack message handler error');
      }
    });
  }

  private isProcessableMessage(event: unknown): event is SlackInboundMessageEvent {
    if (!event || typeof event !== 'object') return false;
    const e = event as Record<string, unknown>;
    if (e.type !== 'message') return false;
    if (e.bot_id != null) return false;
    const st = e.subtype as string | undefined;
    if (st && IGNORE_MESSAGE_SUBTYPES.has(st)) return false;
    if (typeof e.channel !== 'string' || typeof e.ts !== 'string') return false;
    if (typeof e.user !== 'string') return false;
    return true;
  }

  private async handleMessageEvent(event: unknown): Promise<void> {
    if (!this.isProcessableMessage(event)) return;

    let content = typeof event.text === 'string' ? event.text : '';
    if (!content.trim() && event.files && event.files.length > 0) {
      content = '[attachment]';
    }
    if (!content.trim()) return;

    // Replace Slack's <@BOT_ID> mention with @AssistantName so trigger pattern matches
    if (this.botUserId) {
      content = content.replace(
        new RegExp(`<@${this.botUserId}>`, 'g'),
        `@${ASSISTANT_NAME}`,
      );
    }

    const chatJid = `${event.channel}${SLACK_JID_SUFFIX}`;
    const timestamp = slackTsToIso(event.ts);
    const isDm = event.channel.startsWith('D');

    logger.info(
      { chatJid, user: event.user, isDm, preview: content.slice(0, 80) },
      'Slack message received',
    );

    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      const title = await this.resolveConversationTitle(event.channel);
      this.opts.autoRegister(chatJid, title, isDm ? 'slack-dm' : 'slack');
      groups = this.opts.registeredGroups();
    }

    this.opts.onChatMetadata(chatJid, timestamp);

    if (!groups[chatJid]) {
      logger.info({ chatJid }, 'Slack message from unregistered conversation, ignored');
      return;
    }

    const senderName = await this.resolveUserDisplayName(event.user);

    this.opts.onMessage(chatJid, {
      id: `${event.channel}:${event.ts}`,
      chat_jid: chatJid,
      sender: event.user,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private async resolveUserDisplayName(userId: string): Promise<string> {
    const hit = this.userDisplayCache.get(userId);
    if (hit) return hit;
    try {
      const res = await this.app.client.users.info({ user: userId });
      const name = res.user?.real_name || res.user?.profile?.display_name || res.user?.name || userId;
      this.userDisplayCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async resolveConversationTitle(channelId: string): Promise<string> {
    const hit = this.channelTitleCache.get(channelId);
    if (hit) return hit;
    try {
      const res = await this.app.client.conversations.info({ channel: channelId });
      const ch = res.channel;
      let label: string;
      if (ch?.is_im) label = 'DM';
      else if (ch?.is_mpim) label = 'Group DM';
      else if (ch?.name) label = `#${ch.name}`;
      else label = channelId;
      const title = `Slack ${label}`;
      this.channelTitleCache.set(channelId, title);
      return title;
    } catch {
      return `Slack ${channelId}`;
    }
  }

  async connect(): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Slack connection timeout')), 30_000),
    );
    await Promise.race([this.app.start(), timeout]);
    this.connected = true;

    try {
      const auth = await this.app.client.auth.test();
      if (auth.user_id) this.botUserId = auth.user_id as string;
      logger.info({ team: auth.team, user: auth.user, botUserId: this.botUserId }, 'Connected to Slack (Socket Mode)');
    } catch {
      logger.info('Connected to Slack (Socket Mode)');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(SLACK_JID_SUFFIX, '');
    if (!channelId) {
      logger.warn({ jid }, 'Invalid Slack JID, message not sent');
      return;
    }

    const mrkdwn = markdownToSlack(text);
    const chunks = splitMessage(mrkdwn, SLACK_TEXT_CHUNK);
    for (const chunk of chunks) {
      await this.app.client.chat.postMessage({ channel: channelId, text: chunk });
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Slack message sent');
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const channelId = jid.replace(SLACK_JID_SUFFIX, '');
    if (!channelId || !fs.existsSync(imagePath)) {
      logger.warn({ jid, imagePath }, 'Slack channel or file missing, image not sent');
      return;
    }

    await this.app.client.files.uploadV2({
      channel_id: channelId,
      file: imagePath,
      filename: path.basename(imagePath),
      initial_comment: caption || undefined,
    });
    logger.info({ jid, imagePath }, 'Slack image sent');
  }

  async setTyping(_jid: string): Promise<void> {
    // Slack has no bot typing indicator comparable to Discord; no-op
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(SLACK_JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
    logger.info('Disconnected from Slack');
  }
}

function slackTsToIso(ts: string): string {
  const n = parseFloat(ts);
  if (Number.isNaN(n)) return new Date().toISOString();
  return new Date(Math.floor(n * 1000)).toISOString();
}

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Handles bold, italic, strikethrough, links, headings, and code blocks.
 * Leaves code blocks (``` and inline `) untouched since Slack uses the same syntax.
 */
function markdownToSlack(md: string): string {
  // Split on fenced code blocks to avoid transforming content inside them
  const parts = md.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i++) {
    // Odd indices are code blocks — skip them
    if (i % 2 === 1) continue;

    let t = parts[i];
    // Links: [text](url) → <url|text>
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
    // Bold: **text** or __text__ → *text*
    t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');
    t = t.replace(/__(.+?)__/g, '*$1*');
    // Italic: *text* (single, not already bold) or _text_ → _text_
    // Only convert single * that aren't part of ** (already handled above)
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
    // Strikethrough: ~~text~~ → ~text~
    t = t.replace(/~~(.+?)~~/g, '~$1~');
    // Headings: # text → *text*
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    parts[i] = t;
  }
  return parts.join('');
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
