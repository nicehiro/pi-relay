import { spawn, type ChildProcess } from "node:child_process";
import type { DiscordClient } from "./discord.js";
import { splitMessage } from "./formatter.js";

const COALESCE_MIN_CHARS = 1500;
const COALESCE_IDLE_MS = 1000;

// Matches ANSI escape sequences: CSI (ESC[...), OSC (ESC]...\x07 or ESC]...\x1b\\), and single ESC+char
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^[\]])/g;

interface PendingUIRequest {
  id: string;
  method: string;
  options?: string[];
}

export class RpcChild {
  private process: ChildProcess | null = null;
  private _alive = false;
  private _streaming = false;

  private streamBuffer = "";
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushedLength = 0;

  private pendingUI: PendingUIRequest | null = null;
  private eventQueue: Promise<void> = Promise.resolve();

  public onExit: (() => void) | null = null;

  constructor(
    private threadId: string,
    private discord: DiscordClient,
    private cwd: string,
  ) {}

  get alive() { return this._alive; }
  get hasPendingUI() { return this.pendingUI !== null; }

  start(initialTask?: string): void {
    this.process = spawn("pi", ["--mode", "rpc", "--no-session"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_RELAY_CHILD: "1" },
    });

    this._alive = true;

    let buffer = "";
    this.process.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(line);
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`[pi-relay:child:${this.threadId.slice(-6)}] ${msg}`);
    });

    this.process.on("exit", (code) => {
      this._alive = false;
      this._streaming = false;
      this.resetStreamState();
      console.log(`[pi-relay] RPC child ${this.threadId.slice(-6)} exited (code ${code})`);
      this.onExit?.();
    });

    if (initialTask) {
      this.send({ type: "prompt", message: initialTask });
    }
  }

  sendPrompt(username: string, content: string, images?: Array<{ data: string; mimeType: string }>): void {
    if (!this._alive) return;

    const message = `[Discord @${username}]: ${content}`;
    const cmd: Record<string, unknown> = this._streaming
      ? { type: "follow_up", message }
      : { type: "prompt", message };

    if (images?.length) {
      cmd.images = images.map(img => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      }));
    }

    this.send(cmd);
  }

  handleUIResponse(content: string): void {
    if (!this.pendingUI) return;

    const { id, method, options } = this.pendingUI;
    this.pendingUI = null;
    const trimmed = content.trim().toLowerCase();

    if (method === "select" && options) {
      const num = parseInt(trimmed, 10);
      let value: string | undefined;
      if (num >= 1 && num <= options.length) {
        value = options[num - 1];
      } else {
        value = options.find(o => o.toLowerCase() === trimmed);
      }
      if (value) {
        this.send({ type: "extension_ui_response", id, value });
      } else {
        this.send({ type: "extension_ui_response", id, cancelled: true });
        this.discord.sendMessage(this.threadId, "❌ Invalid choice. Operation cancelled.");
      }
    } else if (method === "confirm") {
      const confirmed = ["yes", "y", "1", "true", "ok"].includes(trimmed);
      this.send({ type: "extension_ui_response", id, confirmed });
    } else if (method === "input" || method === "editor") {
      if (trimmed === "/cancel") {
        this.send({ type: "extension_ui_response", id, cancelled: true });
      } else {
        this.send({ type: "extension_ui_response", id, value: content.trim() });
      }
    }
  }

  kill(): void {
    if (this.process && this._alive) {
      this.send({ type: "abort" });
      this.process.kill("SIGTERM");
      this._alive = false;
    }
    this.resetStreamState();
  }

  // --- Private ---

  private send(obj: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(obj) + "\n");
  }

  private handleLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.replace(ANSI_RE, ""));
    } catch {
      return;
    }

    this.eventQueue = this.eventQueue
      .then(() => this.processEvent(event))
      .catch(e => console.error(`[pi-relay] Event processing error:`, e));
  }

  private async processEvent(event: Record<string, unknown>): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this._streaming = true;
        this.resetStreamState();
        await this.discord.sendTyping(this.threadId);
        break;

      case "agent_end":
        this._streaming = false;
        break;

      case "message_update":
        await this.handleMessageUpdate(event);
        break;

      case "turn_end":
        await this.handleTurnEnd(event);
        break;

      case "tool_execution_start":
        await this.discord.sendTyping(this.threadId);
        break;

      case "extension_ui_request":
        this.handleUIRequest(event);
        break;

      case "extension_error":
        await this.discord.sendMessage(
          this.threadId,
          `⚠️ Extension error in \`${event.event}\`: ${event.error}`,
        );
        break;
    }
  }

  private async handleMessageUpdate(event: Record<string, unknown>): Promise<void> {
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!delta || delta.type !== "text_delta") return;

    this.streamBuffer += delta.delta as string;

    if (this.streamBuffer.length - this.lastFlushedLength >= COALESCE_MIN_CHARS) {
      this.flushStreamBuffer();
    } else {
      this.scheduleFlush();
    }

    await this.discord.sendTyping(this.threadId);
  }

  private async handleTurnEnd(event: Record<string, unknown>): Promise<void> {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }

    // Flush remaining text
    if (this.streamBuffer.length > this.lastFlushedLength) {
      const remaining = this.streamBuffer.slice(this.lastFlushedLength);
      if (remaining.trim()) {
        for (const chunk of splitMessage(remaining)) {
          await this.discord.sendMessage(this.threadId, chunk);
        }
      }
    }

    // Upload images from tool results
    const toolResults = (event.toolResults ?? []) as Array<{
      toolName: string;
      content: Array<{ type: string; data?: string; mimeType?: string }>;
    }>;
    for (const tr of toolResults) {
      for (const part of tr.content ?? []) {
        if (part.type === "image" && part.data) {
          const ext = (part.mimeType ?? "image/png").split("/")[1] ?? "png";
          const buf = Buffer.from(part.data, "base64");
          await this.discord.sendFile(this.threadId, buf, `${tr.toolName}.${ext}`);
        }
      }
    }

    // Tool call summaries
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (message?.content) {
      const toolCalls = message.content.filter(p => p.type === "toolCall");
      if (toolCalls.length > 0) {
        const lines = toolCalls.map(tc => {
          const args = (tc.arguments ?? {}) as Record<string, unknown>;
          const pairs = Object.entries(args)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => {
              const s = String(v);
              return `${k}: ${s.length > 50 ? s.slice(0, 50) + "…" : s}`;
            })
            .join(", ");
          return `🔧 **${tc.name}** (${pairs})`;
        });
        await this.discord.sendMessage(this.threadId, lines.join("\n"));
      }
    }

    this.resetStreamState();
  }

  private handleUIRequest(req: Record<string, unknown>): void {
    const { id, method } = req as { id: string; method: string };

    // Fire-and-forget methods
    if (method === "notify") {
      const nt = (req.notifyType as string) ?? "info";
      const prefix = nt === "error" ? "❌" : nt === "warning" ? "⚠️" : "ℹ️";
      this.discord.sendMessage(this.threadId, `${prefix} ${req.message}`);
      return;
    }
    if (["setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method)) {
      return;
    }

    // Dialog methods — wait for Discord user response
    this.pendingUI = { id, method, options: req.options as string[] | undefined };

    if (method === "select") {
      const title = (req.title as string) ?? "Select";
      const opts = ((req.options as string[]) ?? [])
        .map((o, i) => `\`${i + 1}\` — ${o}`)
        .join("\n");
      this.discord.sendMessage(this.threadId, `❓ **${title}**\n${opts}\n*Reply with a number to choose*`);
    } else if (method === "confirm") {
      const title = (req.title as string) ?? "Confirm";
      const msg = req.message ? `\n${req.message}` : "";
      this.discord.sendMessage(this.threadId, `❓ **${title}**${msg}\n*Reply \`yes\` or \`no\`*`);
    } else if (method === "input") {
      const title = (req.title as string) ?? "Input";
      const ph = req.placeholder ? ` (${req.placeholder})` : "";
      this.discord.sendMessage(this.threadId, `📝 **${title}**${ph}\n*Reply with your input, or \`/cancel\` to cancel*`);
    } else if (method === "editor") {
      const title = (req.title as string) ?? "Edit";
      const prefill = req.prefill ? `\n\`\`\`\n${req.prefill}\n\`\`\`` : "";
      this.discord.sendMessage(this.threadId, `📝 **${title}**${prefill}\n*Reply with edited text, or \`/cancel\` to cancel*`);
    }
  }

  private flushStreamBuffer(): void {
    if (this.streamBuffer.length <= this.lastFlushedLength) return;
    const newContent = this.streamBuffer.slice(this.lastFlushedLength);
    if (!newContent.trim()) return;

    // Only flush up to the last complete line to avoid splitting mid-sentence
    const lastNewline = newContent.lastIndexOf("\n");
    if (lastNewline === -1) return; // no complete line yet, wait

    const flushable = newContent.slice(0, lastNewline + 1);
    if (!flushable.trim()) return;

    for (const chunk of splitMessage(flushable)) {
      this.discord.sendMessage(this.threadId, chunk).catch(e => {
        console.error(`[pi-relay] Stream flush error:`, e);
      });
    }
    this.lastFlushedLength += flushable.length;
  }

  private resetStreamState(): void {
    this.streamBuffer = "";
    this.lastFlushedLength = 0;
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => this.flushStreamBuffer(), COALESCE_IDLE_MS);
  }
}
