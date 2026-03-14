import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RelayConfig } from "./types.js";

const CONFIG_PATHS = [
  join(process.env.HOME ?? "", ".pi/agent/relay.yaml"),
  join(process.cwd(), "config.yaml"),
];

interface RawConfig {
  discord?: { token?: string; applicationId?: string };
  machine?: { name?: string };
  channels?: string[];
  auth?: { users?: string[] };
  proxy?: string;
}

export interface ConfigDiagnostic {
  level: "error" | "warning";
  message: string;
}

export function validateConfig(raw: RawConfig): ConfigDiagnostic[] {
  const diags: ConfigDiagnostic[] = [];

  const token = raw.discord?.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    diags.push({ level: "error", message: "No Discord bot token. Set discord.token in config or env DISCORD_BOT_TOKEN" });
  }

  const channels = raw.channels ?? [];
  if (channels.length === 0) {
    diags.push({ level: "error", message: "No channel IDs configured. Set channels[] in config" });
  }
  for (const ch of channels) {
    if (!/^\d{17,20}$/.test(ch)) {
      diags.push({ level: "warning", message: `Channel ID "${ch}" doesn't look like a valid Discord snowflake` });
    }
  }

  if (!raw.machine?.name) {
    diags.push({ level: "warning", message: "No machine.name set — will show as \"unknown\"" });
  }

  const users = raw.auth?.users ?? [];
  if (users.length === 0) {
    diags.push({ level: "warning", message: "No auth.users configured — any Discord user can interact with this bot" });
  }
  for (const u of users) {
    if (!/^\d{17,20}$/.test(u)) {
      diags.push({ level: "warning", message: `User ID "${u}" doesn't look like a valid Discord snowflake` });
    }
  }

  if (!raw.discord?.applicationId && !process.env.DISCORD_APPLICATION_ID) {
    diags.push({ level: "warning", message: "No discord.applicationId set — slash commands won't be registered" });
  }

  return diags;
}

export function loadConfig(): RelayConfig {
  let raw: RawConfig = {};

  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      raw = parse(readFileSync(path, "utf-8")) as RawConfig;
      break;
    }
  }

  const diags = validateConfig(raw);
  const errors = diags.filter(d => d.level === "error");
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join("; "));
  }

  for (const w of diags.filter(d => d.level === "warning")) {
    console.warn(`[pi-relay] ⚠️  ${w.message}`);
  }

  return {
    discord: {
      token: (raw.discord?.token ?? process.env.DISCORD_BOT_TOKEN)!,
      applicationId: raw.discord?.applicationId ?? process.env.DISCORD_APPLICATION_ID,
    },
    machine: { name: raw.machine?.name ?? "unknown" },
    channels: raw.channels!,
    auth: { users: raw.auth?.users ?? [] },
    proxy: raw.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY,
  };
}
