import type { DiscordClient } from "./discord.js";
import { splitMessage } from "./formatter.js";

const EDIT_INTERVAL_MS = 800;
const MSG_SOFT_LIMIT = 1900;

export class StreamCoalescer {
  private buffer = "";
  private finalizedUpTo = 0;
  private activeMsgId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private channelId: string,
    private discord: DiscordClient,
  ) {}

  append(text: string): void {
    this.buffer += text;
    this.scheduleEdit();
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    await this.pending;

    const remaining = this.buffer.slice(this.finalizedUpTo);
    if (!remaining.trim()) {
      this.reset();
      return;
    }

    if (this.activeMsgId) {
      if (remaining.length <= 2000) {
        const ok = await this.discord.editMessage(this.channelId, this.activeMsgId, remaining);
        if (!ok) await this.discord.sendMessage(this.channelId, remaining);
      } else {
        const chunks = splitMessage(remaining);
        const ok = await this.discord.editMessage(this.channelId, this.activeMsgId, chunks[0]);
        if (!ok) await this.discord.sendMessage(this.channelId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await this.discord.sendMessage(this.channelId, chunks[i]);
        }
      }
    } else {
      for (const chunk of splitMessage(remaining)) {
        await this.discord.sendMessage(this.channelId, chunk);
      }
    }

    this.reset();
  }

  reset(): void {
    this.buffer = "";
    this.finalizedUpTo = 0;
    this.activeMsgId = null;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleEdit(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.pending
        .then(() => this.doEdit())
        .catch(e => console.error("[pi-relay] Stream edit error:", e));
    }, EDIT_INTERVAL_MS);
  }

  private async doEdit(): Promise<void> {
    const content = this.buffer.slice(this.finalizedUpTo);
    if (!content.trim()) return;

    // Active message is full — finalize it, start a new one next cycle
    if (this.activeMsgId && content.length > MSG_SOFT_LIMIT) {
      const splitAt = findSplitPoint(content, MSG_SOFT_LIMIT);
      const ok = await this.discord.editMessage(
        this.channelId, this.activeMsgId, content.slice(0, splitAt),
      );
      if (ok) this.finalizedUpTo += splitAt;
      this.activeMsgId = null;
      if (this.buffer.length > this.finalizedUpTo) this.scheduleEdit();
      return;
    }

    if (!this.activeMsgId) {
      const toSend = content.length > MSG_SOFT_LIMIT
        ? content.slice(0, MSG_SOFT_LIMIT)
        : content;
      this.activeMsgId = await this.discord.sendMessage(this.channelId, toSend);
      if (toSend.length >= MSG_SOFT_LIMIT && this.activeMsgId) {
        this.finalizedUpTo += toSend.length;
        this.activeMsgId = null;
        if (this.buffer.length > this.finalizedUpTo) this.scheduleEdit();
      }
    } else {
      const ok = await this.discord.editMessage(this.channelId, this.activeMsgId, content);
      if (!ok) this.activeMsgId = null;
    }
  }
}

function findSplitPoint(text: string, limit: number): number {
  let idx = text.lastIndexOf("\n\n", limit);
  if (idx > limit * 0.5) return idx + 2;
  idx = text.lastIndexOf("\n", limit);
  if (idx > limit * 0.5) return idx + 1;
  idx = text.lastIndexOf(" ", limit);
  if (idx > limit * 0.3) return idx + 1;
  return limit;
}
