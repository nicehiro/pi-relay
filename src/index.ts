import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { basename, join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.js";
import { setupProxy } from "./proxy.js";
import type { DiscordClient, IncomingMessage } from "./discord.js";
import {
  formatIncoming,
  extractText,
  formatToolCalls,
  splitMessage,
} from "./formatter.js";
import { SessionChild } from "./session-child.js";
import { StreamCoalescer } from "./stream.js";
import type { PendingChat } from "./types.js";

const RECONNECT_FILE = join(tmpdir(), "pi-relay-reconnect-channel");

export default function (pi: ExtensionAPI) {

  let discord: DiscordClient | null = null;
  let pendingChat: PendingChat | null = null;
  let configRef: ReturnType<typeof loadConfig> | null = null;
  let reloadFn: (() => Promise<void>) | null = null;
  const children = new Map<string, SessionChild>();

  let coalescer: StreamCoalescer | null = null;
  let prevTextLen = 0;

  function handleDiscordMessage(msg: IncomingMessage) {
    const { channelId, username, content, images, replyContext } = msg;

    const child = children.get(channelId);
    if (child) {
      child.sendPrompt(username, content, images);
      return;
    }

    if (!configRef?.channels.includes(channelId)) return;

    pendingChat = { channelId, username };
    coalescer?.reset();
    coalescer = null;
    prevTextLen = 0;
    if (images.length > 0) {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      parts.push({ type: "text", text: formatIncoming(username, content || "[image]", replyContext) });
      for (const img of images) {
        parts.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      pi.sendUserMessage(parts, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(formatIncoming(username, content, replyContext), { deliverAs: "followUp" });
    }
  }

  function handleCancel(threadId: string) {
    const child = children.get(threadId);
    if (child) {
      child.kill();
      children.delete(threadId);
      discord?.sendMessage(threadId, "🛑 Session cancelled").catch(() => {});
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

  function wireDiscordCallbacks() {
    if (!discord) return;
    discord.onThreadArchived = handleThreadArchived;
    discord.onCancel = handleCancel;
    discord.onSlashCommand = async (interaction) => {
      const sub = interaction.options.getSubcommand();
      if (sub === "status") {
        const channelNames = discord?.getChannelNames() ?? new Map();
        const lines = [
          `**pi-relay** ${discord?.connected ? "🟢" : "🔴"}`,
          `Machine: ${configRef?.machine.name ?? "unknown"}`,
          `Sessions: ${children.size}`,
        ];
        for (const id of configRef?.channels ?? []) {
          lines.push(`#${channelNames.get(id) ?? id}`);
        }
        await interaction.reply({ content: lines.join("\n"), flags: 64 });
      } else if (sub === "stop") {
        const threadId = interaction.channelId;
        const child = children.get(threadId);
        if (child) {
          child.kill();
          children.delete(threadId);
          await interaction.reply({ content: "🛑 Session stopped" });
        } else {
          await interaction.reply({ content: "No active session in this thread", flags: 64 });
        }
      } else if (sub === "reload") {
        if (reloadFn) {
          const reconnectChannel = configRef?.channels[0] ?? interaction.channelId;
          writeFileSync(RECONNECT_FILE, reconnectChannel, "utf-8");
          await interaction.reply({ content: "🔄 Reloading and reconnecting…", flags: 64 });
          reloadFn().catch((e) => console.error("[pi-relay] reload failed:", e));
        } else {
          await interaction.reply({
            content: "⚠️ pi-relay is not fully initialized yet.",
            flags: 64,
          });
        }
      }
    };
  }

  function handleThreadArchived(threadId: string): void {
    const child = children.get(threadId);
    if (!child) return;
    child.kill();
    children.delete(threadId);
  }

  async function killAllChildren(): Promise<void> {
    const kills = Array.from(children.values()).map((c) => c.kill());
    await Promise.allSettled(kills);
    children.clear();
  }

  async function resumeExistingSessions(): Promise<number> {
    if (!discord) return 0;

    const activeThreadIds = await discord.fetchActiveThreadIds();
    let resumed = 0;

    for (const threadId of activeThreadIds) {
      if (children.has(threadId)) continue;

      const child = SessionChild.resume(threadId, discord);
      if (!child) continue;

      child.onExit = () => {
        children.delete(threadId);
        discord?.sendMessage(threadId, "🔌 Session ended").catch(() => {});
      };
      children.set(threadId, child);

      try {
        await child.start();
        await discord.sendMessage(threadId, "🔄 Session resumed");
        resumed++;
      } catch (e: any) {
        children.delete(threadId);
        console.error(`[pi-relay] Failed to resume session in thread ${threadId}:`, e.message);
      }
    }
    return resumed;
  }

  async function connectAndSetup(ctx: { ui: { setStatus(key: string, text: string | undefined): void; notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
    const config = await createDiscordClient();
    wireDiscordCallbacks();
    try {
      await discord!.registerSlashCommands();
    } catch (e: any) {
      console.warn(`[pi-relay] Slash command registration failed: ${e.message}`);
    }
    const resumed = await resumeExistingSessions();
    ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}`);
    const msg = resumed > 0
      ? `pi-relay connected, resumed ${resumed} session(s)`
      : "pi-relay connected";
    ctx.ui.notify(msg, "info");
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    let reconnectChannel: string | undefined;
    try {
      reconnectChannel = readFileSync(RECONNECT_FILE, "utf-8").trim();
      unlinkSync(RECONNECT_FILE);
    } catch {}

    try {
      await connectAndSetup(ctx);
      if (reconnectChannel) {
        await discord?.sendMessage(reconnectChannel, "✅ pi-relay reconnected after reload");
      }
    } catch (e: any) {
      ctx.ui.setStatus("pi-relay", "❌ disconnected");
      ctx.ui.notify(`pi-relay failed: ${e.message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    coalescer?.reset();
    coalescer = null;
    await killAllChildren();
    await discord?.disconnect();
  });

  pi.on("turn_start", async (_event) => {
    if (!pendingChat) return;
    discord?.sendTyping(pendingChat.channelId);
  });

  pi.on("message_update", async (event) => {
    if (!pendingChat || !discord) return;

    const msg = event.message;
    if (!msg || (msg as any).role !== "assistant") return;

    const assistantMsg = msg as unknown as AssistantMessage;
    const currentText = extractText(assistantMsg);

    if (currentText.length > prevTextLen) {
      if (!coalescer) {
        coalescer = new StreamCoalescer(pendingChat.channelId, discord);
      }
      coalescer.append(currentText.slice(prevTextLen));
    }
    prevTextLen = currentText.length;
  });

  pi.on("turn_end", async (event) => {
    if (!pendingChat) return;

    const msg = event.message as unknown as AssistantMessage;
    const fullText = extractText(msg);

    if (fullText.length > prevTextLen && coalescer) {
      coalescer.append(fullText.slice(prevTextLen));
    }

    if (coalescer) {
      await coalescer.flush();
      coalescer = null;
    }
    prevTextLen = 0;

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
    description: "Spawn a new pi session in a Discord thread with its own working directory",
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

      const child = SessionChild.create(threadId, discord, cwd);
      child.onExit = () => {
        children.delete(threadId);
        discord?.sendMessage(threadId, "🔌 Session ended").catch(() => {});
      };
      children.set(threadId, child);

      try {
        await child.start(params.task);
      } catch (e: any) {
        children.delete(threadId);
        await discord.sendMessage(threadId, `❌ Failed to start session: ${e.message}`);
        throw new Error(`Failed to start session: ${e.message}`);
      }

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
      reloadFn = () => ctx.reload();
      const sub = args.trim();

      if (sub === "status" || !sub) {
        if (!discord?.connected) {
          try {
            ctx.ui.notify("Connecting to Discord…", "info");
            await connectAndSetup(ctx);
          } catch (e: any) {
            ctx.ui.setStatus("pi-relay", "❌ disconnected");
            ctx.ui.notify(`Connection failed: ${e.message}`, "error");
            return;
          }
        }

        const channelNames = discord?.getChannelNames() ?? new Map();
        const lines = [
          `**pi-relay**`,
          `Status: 🟢 connected`,
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
            for (const [threadId, child] of children) {
              lines.push(`  thread:${threadId.slice(-6)} alive:${child.alive}`);
            }
          }
        } else {
          lines.push(`Config: not loaded`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "reconnect") {
        try {
          await killAllChildren();
          await discord?.disconnect();
          await connectAndSetup(ctx);
          ctx.ui.notify("Reconnected", "info");
        } catch (e: any) {
          ctx.ui.notify(`Reconnect failed: ${e.message}`, "error");
        }
        return;
      }

      if (sub === "disconnect") {
        await killAllChildren();
        await discord?.disconnect();
        ctx.ui.setStatus("pi-relay", "⚪ disconnected");
        ctx.ui.notify("Disconnected from Discord", "info");
        return;
      }

      if (sub === "reload") {
        ctx.ui.notify("Reloading extensions…", "info");
        await ctx.reload();
        return;
      }

      ctx.ui.notify(
        "Usage: /relay [status|reconnect|disconnect|reload]",
        "warning"
      );
    },
  });
}
