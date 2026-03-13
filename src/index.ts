import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { basename, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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
import type { PendingChat } from "./types.js";

const COALESCE_MIN_CHARS = 1500;
const COALESCE_IDLE_MS = 1000;

const RELAY_DIR = join(process.env.HOME ?? "", ".pi/agent");
const LOCK_FILE = join(RELAY_DIR, "relay-master.lock");
const MAPPING_FILE = join(RELAY_DIR, "relay-mappings.json");

function acquireMasterLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      process.kill(pid, 0);
      return false;
    } catch {
      // Stale lock — remove and retry
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
  mkdirSync(RELAY_DIR, { recursive: true });
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseMasterLock(): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let discord: DiscordClient | null = null;
  let pendingChat: PendingChat | null = null;
  let configRef: ReturnType<typeof loadConfig> | null = null;
  let isMaster = false;
  const threadMappings = new Map<string, string>(); // threadId → tmux session name

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

  async function createDiscordClient() {
    const config = loadConfig();
    configRef = config;
    setupProxy(config.proxy);
    const { DiscordClient } = await import("./discord.js");
    discord = new DiscordClient(config, createMessageHandler);
    await discord.connect();
    return config;
  }

  async function createSessionThread(cwd: string): Promise<void> {
    if (!discord?.connected || !configRef) return;

    const channelId = configRef.channels[0];
    if (!channelId) return;

    const sessionName = pi.getSessionName();
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const name = sessionName || `${date} — ${basename(cwd)}`;
    const welcome = `🤖 **pi** session started\n📁 \`${cwd}\`\n🖥️ ${configRef.machine.name}`;

    const threadId = await discord.createThread(channelId, name, welcome);
    discord.bindThread(threadId);
  }

  // --- Master: thread→tmux mapping persistence ---

  function saveMappings(): void {
    writeFileSync(MAPPING_FILE, JSON.stringify(Object.fromEntries(threadMappings)));
  }

  function loadMappings(): void {
    if (!existsSync(MAPPING_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(MAPPING_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) threadMappings.set(k, v as string);
    } catch {}
  }

  function handleThreadArchived(threadId: string): void {
    const sessionName = threadMappings.get(threadId);
    if (!sessionName) return;
    try {
      execFileSync("tmux", ["kill-session", "-t", sessionName]);
    } catch (e: any) {
      console.error(`[pi-relay] Failed to kill tmux session ${sessionName}:`, e.message);
    }
    threadMappings.delete(threadId);
    saveMappings();
  }

  // --- Init: master vs session mode ---

  async function initRelayMode(cwd: string): Promise<void> {
    isMaster = acquireMasterLock();

    if (isMaster) {
      loadMappings();
      discord!.onThreadArchived = handleThreadArchived;
    } else {
      const envThreadId = process.env.PI_RELAY_THREAD_ID;
      if (envThreadId) {
        discord!.bindThread(envThreadId);
      } else {
        await createSessionThread(cwd);
      }
    }

    // Handle initial task from spawned session
    const taskFile = process.env.PI_RELAY_INITIAL_TASK_FILE;
    if (taskFile && existsSync(taskFile)) {
      const task = readFileSync(taskFile, "utf-8");
      unlinkSync(taskFile);
      pi.sendUserMessage(task, { deliverAs: "followUp" });
    }
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = await createDiscordClient();
      await initRelayMode(ctx.cwd);
      const mode = isMaster ? " (master)" : "";
      ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}${mode}`);
      ctx.ui.notify(`pi-relay connected${mode}`, "info");
    } catch (e: any) {
      ctx.ui.setStatus("pi-relay", "❌ disconnected");
      ctx.ui.notify(`pi-relay failed: ${e.message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    resetStreamState();
    if (isMaster) releaseMasterLock();
    await discord?.disconnect();
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (isMaster || discord?.threadId) return;
    try {
      await createSessionThread(ctx.cwd);
    } catch (e: any) {
      console.error(`[pi-relay] Failed to create thread for new session:`, e.message);
    }
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
      const channelId = discord.threadId ?? configRef?.channels[0];
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
      if (!isMaster) throw new Error("spawn_session is only available on the master instance");
      if (!discord?.connected || !configRef) throw new Error("Discord not connected");

      const cwd = params.cwd || process.env.HOME || "/root";
      const channelId = configRef.channels[0];
      if (!channelId) throw new Error("No channel configured");

      // Thread name
      const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const name = params.name || `${date} — ${basename(cwd)}`;

      // Create thread
      const welcome = `🤖 **pi** session spawned\n📁 \`${cwd}\`\n🖥️ ${configRef.machine.name}`;
      const threadId = await discord.createThread(channelId, name, welcome);

      // tmux session name: thread name + timestamp
      const ts = Math.floor(Date.now() / 1000);
      const safeName = name.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 30);
      const sessionName = `pi-${safeName}-${ts}`;

      // Write initial task to temp file
      let taskFile: string | undefined;
      if (params.task) {
        taskFile = join(tmpdir(), `pi-relay-init-${threadId}`);
        writeFileSync(taskFile, params.task);
      }

      // Build shell command and spawn tmux session
      const envExports = [`export PI_RELAY_THREAD_ID=${threadId}`];
      if (taskFile) envExports.push(`export PI_RELAY_INITIAL_TASK_FILE='${taskFile}'`);
      const shellCmd = [...envExports, `cd '${cwd}'`, "exec pi"].join(" && ");
      execFileSync("tmux", ["new-session", "-d", "-s", sessionName, shellCmd]);

      threadMappings.set(threadId, sessionName);
      saveMappings();

      return {
        content: [{ type: "text", text: `Spawned session in thread "${name}" (tmux: ${sessionName})\ncwd: ${cwd}` }],
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
          `Mode: ${isMaster ? "master" : "session"}`,
        ];

        if (configRef) {
          lines.push(`Machine: ${configRef.machine.name}`);
          lines.push(`Channels:`);
          for (const id of configRef.channels) {
            const name = channelNames.get(id) ?? "unknown";
            lines.push(`  #${name} (${id})`);
          }
          if (discord?.threadId) {
            const threadName = await discord.getThreadName();
            lines.push(`Thread: ${threadName ?? discord.threadId}`);
          }
          if (isMaster && threadMappings.size > 0) {
            lines.push(`Spawned sessions: ${threadMappings.size}`);
          }
        } else {
          lines.push(`Config: not loaded`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "reconnect") {
        try {
          if (isMaster) releaseMasterLock();
          await discord?.disconnect();
          const config = await createDiscordClient();
          await initRelayMode(ctx.cwd);
          const mode = isMaster ? " (master)" : "";
          ctx.ui.setStatus("pi-relay", `🔗 ${config.machine.name}${mode}`);
          ctx.ui.notify(`Reconnected${mode}`, "info");
        } catch (e: any) {
          ctx.ui.notify(`Reconnect failed: ${e.message}`, "error");
        }
        return;
      }

      if (sub === "disconnect") {
        if (isMaster) releaseMasterLock();
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
