import {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';

import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const DISCORD_JID_SUFFIX_CHANNEL = '@discord.channel';
const DISCORD_JID_SUFFIX_DM = '@discord.dm';
const DISCORD_MESSAGE_LIMIT = 2000;

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  prefixAssistantName = false;

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord connection timeout')), 30_000);

      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        clearTimeout(timeout);
        logger.info(
          { botUser: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
          'Connected to Discord',
        );
        resolve();
      });

      this.client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.setupMessageHandler();
      this.client.login(this.opts.token).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupMessageHandler(): void {
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (message.author.bot) return;

      const isGuild = Boolean(message.guild);
      const chatJid = isGuild
        ? `${message.channelId}${DISCORD_JID_SUFFIX_CHANNEL}`
        : `${message.author.id}${DISCORD_JID_SUFFIX_DM}`;

      const timestamp = message.createdAt.toISOString();
      let content = message.content || '';

      // Replace Discord's <@BOT_ID> mention with @AssistantName so trigger pattern matches
      const botId = this.client.user?.id;
      if (botId) {
        content = content.replace(
          new RegExp(`<@!?${botId}>`, 'g'),
          `@${ASSISTANT_NAME}`,
        );
      }

      if (!content && message.attachments.size === 0) return;

      logger.info(
        { chatJid, sender: message.author.tag, isGuild, contentPreview: content.slice(0, 80) },
        'Discord message received',
      );

      this.opts.onChatMetadata(chatJid, timestamp, isGuild ? message.guild!.name : undefined);

      let groups = this.opts.registeredGroups();
      if (!groups[chatJid] && this.opts.autoRegister) {
        const chatName = isGuild
          ? `Discord #${(message.channel as TextChannel).name || message.channelId}`
          : `Discord DM ${message.author.username}`;
        this.opts.autoRegister(chatJid, chatName, 'discord');
        groups = this.opts.registeredGroups();
      }

      if (groups[chatJid]) {
        this.opts.onMessage(chatJid, {
          id: message.id,
          chat_jid: chatJid,
          sender: message.author.id,
          sender_name: message.author.displayName || message.author.username,
          content: content || (message.attachments.size > 0 ? '[attachment]' : ''),
          timestamp,
          is_from_me: false,
        });
      } else {
        logger.info({ chatJid }, 'Discord message from unregistered channel, ignored');
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (!channel) {
      logger.warn({ jid }, 'Discord channel not found, message not sent');
      return;
    }

    const chunks = splitMessage(text, DISCORD_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Discord message sent');
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (!channel) {
      logger.warn({ jid, imagePath }, 'Discord channel not found, image not sent');
      return;
    }

    const attachment = new AttachmentBuilder(imagePath);
    await channel.send({
      content: caption || undefined,
      files: [attachment],
    });
    logger.info({ jid, imagePath }, 'Discord image sent');
  }

  async setTyping(jid: string): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  }

  isConnected(): boolean {
    return this.connected && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(DISCORD_JID_SUFFIX_CHANNEL) || jid.endsWith(DISCORD_JID_SUFFIX_DM);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.destroy();
    logger.info('Disconnected from Discord');
  }

  private async resolveChannel(jid: string): Promise<TextChannel | DMChannel | null> {
    const id = jid
      .replace(DISCORD_JID_SUFFIX_CHANNEL, '')
      .replace(DISCORD_JID_SUFFIX_DM, '');

    if (jid.endsWith(DISCORD_JID_SUFFIX_DM)) {
      try {
        const user = await this.client.users.fetch(id);
        return user.dmChannel || (await user.createDM());
      } catch {
        return null;
      }
    }

    try {
      const ch = await this.client.channels.fetch(id);
      if (ch?.isTextBased()) return ch as TextChannel;
    } catch {
      // channel not found
    }
    return null;
  }
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
