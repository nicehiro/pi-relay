import type { AssistantMessage, ToolCall, TextContent } from "@mariozechner/pi-ai";

const DISCORD_MAX_LEN = 2000;

export function formatIncoming(username: string, content: string): string {
  return `[Discord @${username}]: ${content}`;
}

export function extractText(message: AssistantMessage): string {
  return message.content
    .filter((p) => p.type === "text")
    .map((p) => (p as TextContent).text)
    .join("\n");
}

export function formatToolCalls(message: AssistantMessage): string[] {
  return message.content
    .filter((b) => b.type === "toolCall")
    .map((b) => {
      const tc = b as ToolCall;
      return `🔧 **${tc.name}** ${formatToolArgs(tc)}`;
    });
}

function formatToolArgs(tc: ToolCall): string {
  const args = tc.arguments;
  if (!args || Object.keys(args).length === 0) return "";

  if (tc.name === "bash" && args.command) {
    return `(\`$ ${truncate(String(args.command), 100)}\`)`;
  }
  if ((tc.name === "read" || tc.name === "write" || tc.name === "edit") && args.path) {
    return `(\`${truncate(String(args.path), 100)}\`)`;
  }

  const pairs = Object.entries(args)
    .map(([k, v]) => `${k}=${truncate(String(v), 50)}`)
    .join(", ");
  return `(${truncate(pairs, 150)})`;
}

export function splitMessage(text: string, maxLen = DISCORD_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
