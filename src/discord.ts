import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  Partials,
  AttachmentBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import type { RelayConfig } from "./types.js";

export interface DiscordImage {
  data: string; // base64
  mimeType: string;
}

export type MessageHandler = (
  channelId: string,
  username: string,
  content: string,
  images: DiscordImage[]
) => void;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function isImageAttachment(attachment: { contentType?: string | null; name?: string | null }): boolean {
  if (attachment.contentType && IMAGE_MIME_TYPES.has(attachment.contentType.split(";")[0])) {
    return true;
  }
  const name = attachment.name?.toLowerCase() ?? "";
  return Object.keys(IMAGE_EXTENSIONS).some((ext) => name.endsWith(ext));
}

function guessMimeType(attachment: { contentType?: string | null; name?: string | null }): string {
  if (attachment.contentType) {
    const mime = attachment.contentType.split(";")[0].trim();
    if (IMAGE_MIME_TYPES.has(mime)) return mime;
  }
  const name = attachment.name?.toLowerCase() ?? "";
  for (const [ext, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (name.endsWith(ext)) return mime;
  }
  return "image/png";
}

async function fetchImageAsBase64(url: string, fallbackMime: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    const mimeType = contentType.split(";")[0].trim();
    const finalMime = IMAGE_MIME_TYPES.has(mimeType) ? mimeType : fallbackMime;
    const buffer = await res.arrayBuffer();
    return { data: Buffer.from(buffer).toString("base64"), mimeType: finalMime };
  } catch (e: any) {
    console.error(`[pi-relay] Image fetch failed:`, e.message);
    return null;
  }
}

export class DiscordClient {
  private client: Client | null = null;
  private botUserId: string | null = null;
  private lastProcessedMessageId: string | null = null;
  private _connected = false;
  public onThreadArchived: ((threadId: string) => void) | null = null;

  constructor(
    private config: RelayConfig,
    private onMessage: MessageHandler
  ) {}

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message);
    });

    client.on(Events.ClientReady, (c) => {
      this.botUserId = c.user.id;
      this._connected = true;
      console.log(`[pi-relay] Discord bot ready as ${c.user.tag}`);
    });

    client.on(Events.Error, (error) => {
      console.error(`[pi-relay] Discord error:`, error.message);
    });

    client.on(Events.ShardDisconnect, () => {
      this._connected = false;
      console.warn(`[pi-relay] Discord disconnected (shard reconnect will handle)`);
    });

    client.on(Events.ShardResume, () => {
      this._connected = true;
      console.log(`[pi-relay] Discord reconnected`);
    });

    client.on(Events.ThreadUpdate, async (_oldThread, newThread) => {
      if (!this.onThreadArchived) return;
      const thread = newThread.partial ? await newThread.fetch() : newThread;
      if (thread.archived && thread.parentId && this.config.channels.includes(thread.parentId)) {
        this.onThreadArchived(thread.id);
      }
    });

    client.on(Events.ThreadDelete, (thread) => {
      this.onThreadArchived?.(thread.id);
    });

    await client.login(this.config.discord.token);
    this.client = client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this._connected = false;
    }
  }

  async createThread(channelId: string, name: string, welcomeMessage: string): Promise<string> {
    if (!this.client) throw new Error("Discord client not connected");

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("threads" in channel)) {
      throw new Error(`Channel ${channelId} not found or doesn't support threads`);
    }

    const thread = await (channel as TextChannel).threads.create({
      name: name.slice(0, 100),
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });

    await thread.send(welcomeMessage);
    return thread.id;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.content && message.attachments.size === 0) return;
    if (message.id === this.lastProcessedMessageId) return;

    const channelId = message.channelId;

    // Accept messages in configured channels or threads under them
    const isConfiguredChannel = this.config.channels.includes(channelId);
    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    const isChildThread = !!parentId && this.config.channels.includes(parentId);
    if (!isConfiguredChannel && !isChildThread) return;

    if (
      this.config.auth.users.length > 0 &&
      !this.config.auth.users.includes(message.author.id)
    ) {
      return;
    }

    this.lastProcessedMessageId = message.id;

    const images: DiscordImage[] = [];
    try {
      for (const attachment of message.attachments.values()) {
        if (isImageAttachment(attachment)) {
          const mime = guessMimeType(attachment);
          const url = attachment.proxyURL ?? attachment.url;
          const img = await fetchImageAsBase64(url, mime);
          if (img) images.push(img);
        }
      }
    } catch (e: any) {
      console.error(`[pi-relay] Error processing attachments:`, e.message);
    }

    const username = message.author.displayName ?? message.author.username;
    this.onMessage(channelId, username, message.content ?? "", images);
  }

  async sendMessage(channelId: string, text: string): Promise<string | null> {
    if (!this.client) return null;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) return null;

    const msg = await (channel as TextChannel).send(text);
    return msg.id;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("messages" in channel)) return false;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text);
      return true;
    } catch (e: any) {
      console.error(`[pi-relay] Edit message failed:`, e.message);
      return false;
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "sendTyping" in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // ignore typing indicator failures
    }
  }

  async sendFile(channelId: string, data: Buffer, filename: string, description?: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) return;

    const attachment = new AttachmentBuilder(data, { name: filename, description });
    await (channel as TextChannel).send({ files: [attachment] });
  }

  getChannelNames(): Map<string, string> {
    const names = new Map<string, string>();
    if (!this.client) return names;

    for (const id of this.config.channels) {
      const channel = this.client.channels.cache.get(id);
      if (channel && "name" in channel) {
        names.set(id, (channel as TextChannel).name);
      } else {
        names.set(id, id);
      }
    }
    return names;
  }
}
