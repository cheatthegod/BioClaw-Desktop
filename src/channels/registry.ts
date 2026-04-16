/**
 * Channel Registry — factory pattern for channel instantiation.
 * Each channel registers a factory; the orchestrator calls createChannels()
 * to instantiate all configured channels without hardcoding them.
 */
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface ChannelCallbacks {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister: (jid: string, name: string, channelName: string) => void;
}

export type ChannelFactory = (callbacks: ChannelCallbacks) => Channel | null;

const factories = new Map<string, ChannelFactory>();

/**
 * Register a channel factory. Called at module load time by each channel.
 */
export function registerChannelFactory(name: string, factory: ChannelFactory): void {
  factories.set(name, factory);
}

/**
 * Create all configured channels. Returns instantiated (but not yet connected) channels.
 */
export function createChannels(callbacks: ChannelCallbacks): Channel[] {
  const channels: Channel[] = [];

  for (const [name, factory] of factories) {
    try {
      const channel = factory(callbacks);
      if (channel) {
        channels.push(channel);
        logger.debug({ channel: name }, 'Channel created');
      } else {
        logger.debug({ channel: name }, 'Channel skipped (not configured)');
      }
    } catch (err) {
      logger.error({ channel: name, err }, 'Channel factory error');
    }
  }

  return channels;
}

/**
 * Connect all channels, logging errors but not failing.
 */
export async function connectChannels(channels: Channel[]): Promise<void> {
  for (const channel of channels) {
    try {
      await channel.connect();
    } catch (err) {
      logger.error({ channel: channel.name, err }, 'Channel connection failed, continuing');
    }
  }
}
