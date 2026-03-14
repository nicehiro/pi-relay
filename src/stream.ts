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
  private reopenFence: string | null = null; // fence marker to prepend on next cycle

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

    let remaining = this.buffer.slice(this.finalizedUpTo);
    if (this.reopenFence) {
      remaining = this.reopenFence + "\n" + remaining;
      this.reopenFence = null;
    }
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
    this.reopenFence = null;
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
    let content = this.buffer.slice(this.finalizedUpTo);
    if (this.reopenFence) {
      content = this.reopenFence + "\n" + content;
    }
    if (!content.trim()) return;

    // Active message is full — finalize it, start a new one next cycle
    if (this.activeMsgId && content.length > MSG_SOFT_LIMIT) {
      const splitAt = findSafeSplitPoint(content, MSG_SOFT_LIMIT);
      const head = content.slice(0, splitAt);
      const openMarker = findUnclosedFence(head);
      const finalText = openMarker ? head + "\n```" : head;
      const ok = await this.discord.editMessage(
        this.channelId, this.activeMsgId, finalText,
      );
      if (ok) {
        // Adjust finalizedUpTo: account for reopenFence prefix we prepended
        const prefixLen = this.reopenFence ? this.reopenFence.length + 1 : 0;
        this.finalizedUpTo += splitAt - prefixLen;
        this.reopenFence = openMarker;
      }
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
        const prefixLen = this.reopenFence ? this.reopenFence.length + 1 : 0;
        this.finalizedUpTo += toSend.length - prefixLen;
        this.reopenFence = findUnclosedFence(toSend);
        this.activeMsgId = null;
        if (this.buffer.length > this.finalizedUpTo) this.scheduleEdit();
      } else {
        this.reopenFence = null;
      }
    } else {
      const ok = await this.discord.editMessage(this.channelId, this.activeMsgId, content);
      if (!ok) this.activeMsgId = null;
    }
  }
}

const FENCE_LINE_RE = /^(`{3,}|~{3,})(.*)?$/;

// Find a split point that avoids breaking inside fenced code blocks.
// Prefers splitting at a paragraph/line boundary outside a fence.
function findSafeSplitPoint(text: string, limit: number): number {
  const candidate = text.slice(0, limit);
  const lines = candidate.split("\n");

  let fenceMarker: string | null = null;
  let fenceMarkerLen = 0;
  let lastSafeNewline = -1;
  let pos = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const m = trimmed.match(FENCE_LINE_RE);
    if (m) {
      if (!fenceMarker) {
        fenceMarker = trimmed;
        fenceMarkerLen = m[1].length;
      } else if (m[1][0] === fenceMarker[0] && m[1].length >= fenceMarkerLen && !m[2]?.trim()) {
        fenceMarker = null;
        fenceMarkerLen = 0;
      }
    }
    pos += line.length + 1;
    if (!fenceMarker && pos <= limit) lastSafeNewline = pos;
  }

  if (lastSafeNewline > limit * 0.3) return lastSafeNewline;

  let idx = text.lastIndexOf("\n", limit);
  if (idx > limit * 0.5) return idx + 1;
  idx = text.lastIndexOf(" ", limit);
  if (idx > limit * 0.3) return idx + 1;
  return limit;
}

// Return the opening fence marker if the text has an unclosed fenced code block, else null.
function findUnclosedFence(text: string): string | null {
  let fenceMarker: string | null = null;
  let fenceMarkerLen = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const m = trimmed.match(FENCE_LINE_RE);
    if (m) {
      if (!fenceMarker) {
        fenceMarker = trimmed;
        fenceMarkerLen = m[1].length;
      } else if (m[1][0] === fenceMarker[0] && m[1].length >= fenceMarkerLen && !m[2]?.trim()) {
        fenceMarker = null;
        fenceMarkerLen = 0;
      }
    }
  }

  return fenceMarker;
}
