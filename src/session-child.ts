import type {
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { DiscordClient, DiscordImage } from "./discord.js";
import { formatToolCalls } from "./formatter.js";
import { StreamCoalescer } from "./stream.js";
import { createDiscordUIContext } from "./discord-ui.js";

const SESSIONS_BASE = join(
  process.env.HOME ?? "/root",
  ".pi/agent/pi-relay/sessions",
);

export function sessionDirForThread(threadId: string): string {
  return join(SESSIONS_BASE, threadId);
}

function findRecentSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const p = join(dir, f);
        return { path: p, mtime: statSync(p).mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

function readSessionHeader(filePath: string): { cwd: string } | null {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(1024);
    const bytesRead = readSync(fd, buf, 0, 1024, 0);
    closeSync(fd);
    const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
    if (!firstLine) return null;
    const header = JSON.parse(firstLine);
    if (
      header.type === "session" &&
      typeof header.id === "string" &&
      typeof header.cwd === "string"
    ) {
      return { cwd: header.cwd };
    }
    return null;
  } catch {
    return null;
  }
}

export class SessionChild {
  private session: AgentSession | null = null;
  private coalescer: StreamCoalescer | null = null;
  private toolProgressTimers = new Map<string, ReturnType<typeof setTimeout>>(); // toolCallId → debounce timer
  private toolProgressMessages = new Map<string, string>(); // toolCallId → messageId
  private _alive = false;

  public onExit: (() => void) | null = null;

  private constructor(
    private threadId: string,
    private discord: DiscordClient,
    private cwd: string,
    private sessionManager: SessionManager,
  ) {}

  get alive() { return this._alive; }

  static create(
    threadId: string,
    discord: DiscordClient,
    cwd: string,
  ): SessionChild {
    const sessionDir = sessionDirForThread(threadId);
    const sm = SessionManager.create(cwd, sessionDir);
    return new SessionChild(threadId, discord, cwd, sm);
  }

  static resume(
    threadId: string,
    discord: DiscordClient,
  ): SessionChild | null {
    const sessionDir = sessionDirForThread(threadId);
    if (!existsSync(sessionDir)) return null;

    const filePath = findRecentSessionFile(sessionDir);
    if (!filePath) return null;

    const header = readSessionHeader(filePath);
    if (!header) return null;

    const sm = SessionManager.open(filePath, sessionDir);
    return new SessionChild(threadId, discord, header.cwd, sm);
  }

  async start(initialTask?: string): Promise<void> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (ext) => !ext.resolvedPath.includes("pi-relay"),
        ),
      }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      resourceLoader,
      sessionManager: this.sessionManager,
    });

    this.session = session;
    this._alive = true;

    const uiContext = createDiscordUIContext(this.threadId, this.discord);
    await session.bindExtensions({ uiContext });

    session.subscribe(((event: AgentSessionEvent) => {
      this.handleEvent(event).catch((e) =>
        console.error("[pi-relay] Event handling error:", e),
      );
    }) as AgentSessionEventListener);

    if (initialTask) {
      session.prompt(initialTask).catch((e) =>
        console.error("[pi-relay] Initial prompt error:", e),
      );
    }
  }

  sendPrompt(
    username: string,
    content: string,
    images?: DiscordImage[],
  ): void {
    if (!this.session || !this._alive) return;

    const message = `[Discord @${username}]: ${content}`;

    const imgContent = images?.length
      ? images.map((img) => ({
          type: "image" as const,
          data: img.data,
          mimeType: img.mimeType,
        }))
      : undefined;

    if (this.session.isStreaming) {
      this.session.followUp(message, imgContent).catch((e) =>
        console.error("[pi-relay] Follow-up error:", e),
      );
    } else {
      this.session
        .prompt(message, { images: imgContent })
        .catch((e) => console.error("[pi-relay] Prompt error:", e));
    }
  }

  async kill(): Promise<void> {
    if (!this._alive) return;
    this._alive = false;

    if (this.session) {
      await this.session.abort();
      this.session.dispose();
      this.session = null;
    }

    this.coalescer?.reset();
    this.coalescer = null;
    await this.cleanupProgressMessages();
    this.onExit?.();
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.coalescer = new StreamCoalescer(this.threadId, this.discord);
        await this.discord.sendTyping(this.threadId);
        break;

      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta.type !== "text_delta") break;

        if (!this.coalescer) {
          this.coalescer = new StreamCoalescer(this.threadId, this.discord);
        }
        this.coalescer.append(delta.delta);
        break;
      }

      case "turn_end":
        await this.handleTurnEnd(event.message, event.toolResults);
        break;

      case "tool_execution_start": {
        const timer = setTimeout(async () => {
          this.toolProgressTimers.delete(event.toolCallId);
          const msgId = await this.discord.sendMessage(
            this.threadId,
            `⏳ Running \`${event.toolName}\`…`,
          );
          if (msgId) {
            this.toolProgressMessages.set(event.toolCallId, msgId);
          }
        }, 500);
        this.toolProgressTimers.set(event.toolCallId, timer);
        break;
      }

      case "tool_execution_end": {
        const timer = this.toolProgressTimers.get(event.toolCallId);
        if (timer) {
          clearTimeout(timer);
          this.toolProgressTimers.delete(event.toolCallId);
        }
        const msgId = this.toolProgressMessages.get(event.toolCallId);
        if (msgId) {
          this.toolProgressMessages.delete(event.toolCallId);
          await this.discord.deleteMessage(this.threadId, msgId);
        }
        break;
      }

      case "auto_compaction_start":
        await this.discord.sendMessage(
          this.threadId,
          "🔄 Compacting context...",
        );
        break;

      case "auto_compaction_end":
        if (event.result) {
          await this.discord.sendMessage(
            this.threadId,
            `✅ Context compacted (${event.result.tokensBefore} tokens)`,
          );
        } else if (event.aborted) {
          await this.discord.sendMessage(
            this.threadId,
            "⚠️ Compaction aborted",
          );
        } else if (event.errorMessage) {
          await this.discord.sendMessage(
            this.threadId,
            `❌ Compaction failed: ${event.errorMessage}`,
          );
        }
        break;

      case "auto_retry_start":
        await this.discord.sendMessage(
          this.threadId,
          `⏳ Retrying (attempt ${event.attempt}/${event.maxAttempts}, waiting ${Math.round(event.delayMs / 1000)}s)...`,
        );
        break;

      case "auto_retry_end":
        if (!event.success) {
          await this.discord.sendMessage(
            this.threadId,
            `❌ Retry failed after ${event.attempt} attempts: ${event.finalError ?? "unknown error"}`,
          );
        }
        break;
    }
  }

  private async cleanupProgressMessages(): Promise<void> {
    for (const timer of this.toolProgressTimers.values()) {
      clearTimeout(timer);
    }
    this.toolProgressTimers.clear();
    const messageIds = [...this.toolProgressMessages.values()];
    this.toolProgressMessages.clear();
    await Promise.all(
      messageIds.map((msgId) => this.discord.deleteMessage(this.threadId, msgId)),
    );
  }

  private async handleTurnEnd(
    message: unknown,
    toolResults: ToolResultMessage[],
  ): Promise<void> {
    if (this.coalescer) {
      await this.coalescer.flush();
      this.coalescer = null;
    }

    await this.cleanupProgressMessages();

    // Upload images from tool results
    for (const tr of toolResults) {
      for (const part of tr.content) {
        if (part.type === "image") {
          const imgPart = part as { type: "image"; data: string; mimeType: string };
          const ext = imgPart.mimeType.split("/")[1] ?? "png";
          const buf = Buffer.from(imgPart.data, "base64");
          await this.discord.sendFile(
            this.threadId,
            buf,
            `${tr.toolName}.${ext}`,
          );
        }
      }
    }

    // Tool call summaries
    const assistantMsg = message as AssistantMessage | undefined;
    if (!assistantMsg?.content) return;

    const hasTools = assistantMsg.content.some((p) => p.type === "toolCall");
    if (hasTools) {
      const toolLines = formatToolCalls(assistantMsg).join("\n");
      if (toolLines) {
        await this.discord.sendMessage(this.threadId, toolLines);
      }
    }
  }
}
