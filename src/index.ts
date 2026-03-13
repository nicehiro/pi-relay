import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.js";
import { setupProxy } from "./proxy.js";
import type { DiscordClient, DiscordImage } from "./discord.js";
import {
  formatIncoming,
  extractText,
  formatToolCalls,
  splitMessage,
} from "./formatter.js";
import { RpcChild } from "./rpc-child.js";
import type { PendingChat } from "./types.js";

const COALESCE_MIN_CHARS = 1500;
const COALESCE_IDLE_MS = 1000;

export default function (pi: ExtensionAPI) {
  // Child RPC processes inherit the extension but must not connect to Discord
  // or register tools — the parent handles all Discord I/O for them.
  if (process.env.PI_RELAY_CHILD) return;
  let discord: DiscordClient | null = null;
  let pendingChat: PendingChat | null = null;
  let configRef: ReturnType<typeof loadConfig> | null = null;
  const children = new Map<string, RpcChild>(); // threadId → RpcChild

  // Streaming coalesce state (master's own messages)
  let streamBuffer = "";
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushedLength = 0;

  function flushStreamBuffer() {
    if (!pendingChat || streamBuffer.length <= lastFlushedLength) return;

    const newContent = streamBuffer.slice(lastFlushedLength);
    if (!newContent.trim()) return;

    // Only flush up to the last complete line to avoid splitting mid-sentence
    const lastNewline = newContent.lastIndexOf("\n");
    if (lastNewline === -1) return; // no complete line yet, wait

    const flushable = newContent.slice(0, lastNewline + 1);
    if (!flushable.trim()) return;

    const chunks = splitMessage(flushable);
    for (const chunk of chunks) {
      discord?.sendMessage(pendingChat.channelId, chunk).catch((e) => {
        console.error(`[pi-relay] Failed to send stream chunk:`, e);
      });
    }
    lastFlushedLength += flushable.length;
  }

  function resetStreamState() {
    streamBuffer = "";
    lastFlushedLength = 0;
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  }

  function scheduleFlush() {
    if (streamTimer) clearTimeout(streamTimer);
    streamTimer = setTimeout(flushStreamBuffer, COALESCE_IDLE_MS);
  }

  function handleDiscordMessage(channelId: string, username: string, content: string, images: DiscordImage[]) {
    // Route to RPC child if message is in a managed thread
    const child = children.get(channelId);
    if (child) {
      if (child.hasPendingUI) {
        child.handleUIResponse(content);
      } else {
        child.sendPrompt(username, content, images);
      }
      return;
    }

    // Main channel → master pi
    if (!configRef?.channels.includes(channelId)) return;

    pendingChat = { channelId, username };
    resetStreamState();
    if (images.length > 0) {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      parts.push({ type: "text", text: formatIncoming(username, content || "[image]") });
      for (const img of images) {
        parts.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      pi.sendUserMessage(parts, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(formatIncoming(username, content), { deliverAs: "followUp" });
    }
  }

  async function createDiscordClient() {
    const config = loadConfig();
    configRef = config;
    setupProxy(config.proxy);
    const { DiscordClient } = await import("./discord.js");
    discord = new DiscordClient(config, handleDiscordMessage);
    await discord.connect();
    return config;
  }

  function handleThreadArchived(threadId: string): void {
    const child = children.get(threadId);
    if (!child) return;
    child.kill();
    children.delete(threadId);
  }

  function killAllChildren(): void {
    for (const child of children.values()) {
      child.kill();
    }
    children.clear();
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = await createDiscordClient();
      discord!.onThreadArchived = handleThreadArchived;
      ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}`);
      ctx.ui.notify("pi-relay connected", "info");
    } catch (e: any) {
      ctx.ui.setStatus("pi-relay", "❌ disconnected");
      ctx.ui.notify(`pi-relay failed: ${e.message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    resetStreamState();
    killAllChildren();
    await discord?.disconnect();
  });

  pi.on("turn_start", async (_event) => {
    if (!pendingChat) return;
    discord?.sendTyping(pendingChat.channelId);
  });

  pi.on("message_update", async (event) => {
    if (!pendingChat) return;

    const msg = event.message;
    if (!msg || (msg as any).role !== "assistant") return;

    const assistantMsg = msg as unknown as AssistantMessage;
    const currentText = extractText(assistantMsg);

    streamBuffer = currentText;

    if (streamBuffer.length - lastFlushedLength >= COALESCE_MIN_CHARS) {
      flushStreamBuffer();
    } else {
      scheduleFlush();
    }

    discord?.sendTyping(pendingChat.channelId);
  });

  pi.on("turn_end", async (event) => {
    if (!pendingChat) return;

    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }

    const msg = event.message as unknown as AssistantMessage;

    const fullText = extractText(msg);
    const remaining = lastFlushedLength > 0 ? fullText.slice(lastFlushedLength) : fullText;
    if (remaining.trim()) {
      for (const chunk of splitMessage(remaining)) {
        await discord?.sendMessage(pendingChat.channelId, chunk);
      }
    }

    for (const tr of event.toolResults) {
      for (const part of tr.content) {
        if (part.type === "image" && "data" in part) {
          const imgPart = part as { type: "image"; data: string; mimeType: string };
          const ext = imgPart.mimeType.split("/")[1] ?? "png";
          const buf = Buffer.from(imgPart.data, "base64");
          await discord?.sendFile(pendingChat.channelId, buf, `${tr.toolName}.${ext}`);
        }
      }
    }

    const hasTools = msg.content.some((p) => p.type === "toolCall");
    if (hasTools) {
      const toolLines = formatToolCalls(msg).join("\n");
      if (toolLines) {
        await discord?.sendMessage(pendingChat.channelId, toolLines);
      }
    } else {
      pendingChat = null;
    }

    resetStreamState();
  });

  // --- Tools ---

  pi.registerTool({
    name: "discord_send",
    label: "Discord Send",
    description: "Send a message to this machine's Discord channel",
    parameters: Type.Object({
      message: Type.String({ description: "Message to send (supports markdown)" }),
    }),
    async execute(_toolCallId, params) {
      if (!discord?.connected) {
        throw new Error("Discord is not connected");
      }
      const channelId = configRef?.channels[0];
      if (!channelId) {
        throw new Error("No channel configured");
      }

      const chunks = splitMessage(params.message);
      for (const chunk of chunks) {
        await discord.sendMessage(channelId, chunk);
      }

      return {
        content: [{ type: "text", text: `Sent to Discord channel ${channelId}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spawn_session",
    label: "Spawn Session",
    description: "Spawn a new pi session in a tmux session with its own Discord thread",
    promptGuidelines: [
      "Use spawn_session when a Discord user asks to start a new session or work on a task in a specific directory",
      "Extract working directory, session name, and task from the user's free-form request",
      "If no directory is specified, leave cwd empty to default to home directory",
    ],
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Working directory (default: ~)" })),
      name: Type.Optional(Type.String({ description: "Session/thread name" })),
      task: Type.Optional(Type.String({ description: "Initial task for the new session" })),
    }),
    async execute(_toolCallId, params) {
      if (!discord?.connected || !configRef) throw new Error("Discord not connected");

      const cwd = params.cwd || process.env.HOME || "/root";
      const channelId = configRef.channels[0];
      if (!channelId) throw new Error("No channel configured");

      const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const name = params.name || `${date} — ${basename(cwd)}`;

      const welcome = `🤖 **pi** session spawned\n📁 \`${cwd}\`\n🖥️ ${configRef.machine.name}`;
      const threadId = await discord.createThread(channelId, name, welcome);

      const child = new RpcChild(threadId, discord, cwd);
      child.onExit = () => {
        children.delete(threadId);
        discord?.sendMessage(threadId, "🔌 Session ended").catch(() => {});
      };
      children.set(threadId, child);
      child.start(params.task);

      return {
        content: [{ type: "text", text: `Spawned session in thread "${name}"\ncwd: ${cwd}` }],
        details: {},
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("relay", {
    description: "Show Discord relay status",
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "status" || !sub) {
        const connected = discord?.connected ?? false;
        const channelNames = discord?.getChannelNames() ?? new Map();
        const lines = [
          `**pi-relay**`,
          `Status: ${connected ? "🟢 connected" : "🔴 disconnected"}`,
        ];

        if (configRef) {
          lines.push(`Machine: ${configRef.machine.name}`);
          lines.push(`Channels:`);
          for (const id of configRef.channels) {
            const name = channelNames.get(id) ?? "unknown";
            lines.push(`  #${name} (${id})`);
          }
          if (children.size > 0) {
            lines.push(`Active sessions: ${children.size}`);
          }
        } else {
          lines.push(`Config: not loaded`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "reconnect") {
        try {
          killAllChildren();
          await discord?.disconnect();
          const config = await createDiscordClient();
          discord!.onThreadArchived = handleThreadArchived;
          ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}`);
          ctx.ui.notify("Reconnected", "info");
        } catch (e: any) {
          ctx.ui.notify(`Reconnect failed: ${e.message}`, "error");
        }
        return;
      }

      if (sub === "disconnect") {
        killAllChildren();
        await discord?.disconnect();
        ctx.ui.setStatus("pi-relay", "⚪ disconnected");
        ctx.ui.notify("Disconnected from Discord", "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /relay [status|reconnect|disconnect]",
        "warning"
      );
    },
  });
}
