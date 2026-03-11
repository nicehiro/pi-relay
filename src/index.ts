import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.js";
import { DiscordClient, type DiscordImage } from "./discord.js";
import {
  formatIncoming,
  extractText,
  formatNonTextParts,
  formatToolResult,
  splitMessage,
} from "./formatter.js";
import type { PendingChat } from "./types.js";

const COALESCE_MIN_CHARS = 1500;
const COALESCE_IDLE_MS = 1000;

export default function (pi: ExtensionAPI) {
  let discord: DiscordClient | null = null;
  let pendingChat: PendingChat | null = null;
  let configRef: ReturnType<typeof loadConfig> | null = null;

  // Streaming coalesce state
  let streamBuffer = "";
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushedLength = 0;

  function flushStreamBuffer() {
    if (!pendingChat || streamBuffer.length <= lastFlushedLength) return;

    const newContent = streamBuffer.slice(lastFlushedLength);
    if (!newContent.trim()) return;

    const chunks = splitMessage(newContent);
    for (const chunk of chunks) {
      discord?.sendMessage(pendingChat.channelId, chunk).catch((e) => {
        console.error(`[pi-relay] Failed to send stream chunk:`, e);
      });
    }
    lastFlushedLength = streamBuffer.length;
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

  function createMessageHandler(channelId: string, username: string, content: string, images: DiscordImage[]) {
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = loadConfig();
      configRef = config;
      discord = new DiscordClient(config, createMessageHandler);
      await discord.connect();
      ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}`);
      ctx.ui.notify(`pi-relay connected as bot to ${config.channels.length} channel(s)`, "info");
    } catch (e: any) {
      ctx.ui.setStatus("pi-relay", "❌ disconnected");
      ctx.ui.notify(`pi-relay failed: ${e.message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    resetStreamState();
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

    // Keep typing indicator alive
    discord?.sendTyping(pendingChat.channelId);
  });

  pi.on("turn_end", async (event) => {
    if (!pendingChat) return;

    // Cancel any pending stream flush
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }

    const msg = event.message as unknown as AssistantMessage;

    // Send any remaining unflushed text (answer only, no tool calls/thinking)
    const fullText = extractText(msg);
    const remaining = lastFlushedLength > 0 ? fullText.slice(lastFlushedLength) : fullText;
    if (remaining.trim()) {
      for (const chunk of splitMessage(remaining)) {
        await discord?.sendMessage(pendingChat.channelId, chunk);
      }
    }

    // Upload image content from tool results (skip text summaries)
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

    // Clear pending if no more tool calls
    const hasTools = msg.content.some((p) => p.type === "toolCall");
    if (!hasTools) {
      pendingChat = null;
    }

    resetStreamState();
  });

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

        try {
          const config = loadConfig();
          lines.push(`Machine: ${config.machine.name}`);
          lines.push(`Channels:`);
          for (const id of config.channels) {
            const name = channelNames.get(id) ?? "unknown";
            lines.push(`  #${name} (${id})`);
          }
        } catch {
          lines.push(`Config: error loading`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "reconnect") {
        try {
          await discord?.disconnect();
          const config = loadConfig();
          discord = new DiscordClient(config, createMessageHandler);
          await discord.connect();
          ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}`);
          ctx.ui.notify("Reconnected to Discord", "info");
        } catch (e: any) {
          ctx.ui.notify(`Reconnect failed: ${e.message}`, "error");
        }
        return;
      }

      if (sub === "disconnect") {
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
