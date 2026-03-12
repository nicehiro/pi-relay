import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RelayConfig } from "./types.js";

const CONFIG_PATHS = [
  join(process.env.HOME ?? "", ".pi/agent/relay.yaml"),
  join(process.cwd(), "config.yaml"),
];

interface RawConfig {
  discord?: { token?: string };
  machine?: { name?: string };
  channels?: string[];
  auth?: { users?: string[] };
  proxy?: string;
}

export function loadConfig(): RelayConfig {
  let raw: RawConfig = {};

  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      raw = parse(readFileSync(path, "utf-8")) as RawConfig;
      break;
    }
  }

  const token = raw.discord?.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "No Discord bot token. Set discord.token in config.yaml or env DISCORD_BOT_TOKEN"
    );
  }

  const channels = raw.channels ?? [];
  if (channels.length === 0) {
    throw new Error("No channel IDs configured. Set channels[] in config.yaml");
  }

  return {
    discord: { token },
    machine: { name: raw.machine?.name ?? "unknown" },
    channels,
    auth: { users: raw.auth?.users ?? [] },
    proxy: raw.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY,
  };
}
