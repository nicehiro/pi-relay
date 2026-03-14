import type { AssistantMessage, ToolCall, TextContent } from "@mariozechner/pi-ai";

const DISCORD_MAX_LEN = 2000;
const TABLE_ROW_RE = /^\|(.+\|)+$/;
const SEPARATOR_RE = /^\|[\s:-]+(\|[\s:-]+)+\|?$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)?$/;

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

// Convert markdown tables to code blocks since Discord doesn't render tables.
// Parses cells, pads columns to equal width, and wraps in a fenced code block.
export function tablesToCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let tableLines: string[] = [];

  function flushTable() {
    if (tableLines.length === 0) return;

    const rows = tableLines
      .filter(l => !SEPARATOR_RE.test(l.trim()))
      .map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));

    const colCount = Math.max(...rows.map(r => r.length));
    const widths = Array.from({ length: colCount }, (_, i) =>
      Math.max(...rows.map(r => (r[i] ?? "").length), 1),
    );

    const formatted = rows.map(r =>
      widths.map((w, i) => (r[i] ?? "").padEnd(w)).join("  "),
    );

    // Insert separator after header row
    if (formatted.length > 1) {
      const sep = widths.map(w => "─".repeat(w)).join("──");
      formatted.splice(1, 0, sep);
    }

    out.push("```");
    out.push(...formatted);
    out.push("```");
    tableLines = [];
  }

  let inFence = false;
  let fenceMarkerLen = 0;
  let fenceChar = "";
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(FENCE_RE);

    if (m) {
      if (!inFence) {
        flushTable();
        inFence = true;
        fenceChar = m[1][0];
        fenceMarkerLen = m[1].length;
      } else if (m[1][0] === fenceChar && m[1].length >= fenceMarkerLen && !m[2]?.trim()) {
        inFence = false;
        fenceMarkerLen = 0;
        fenceChar = "";
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (TABLE_ROW_RE.test(trimmed) || SEPARATOR_RE.test(trimmed)) {
      tableLines.push(line);
    } else {
      flushTable();
      out.push(line);
    }
  }

  flushTable();
  return out.join("\n");
}

// Split text into chunks that fit Discord's 2000-char limit.
// Respects fenced code blocks — won't split inside one unless forced,
// and re-opens the fence in the next chunk if it does.
// Handles nested fences (e.g. ```` containing ```).
export function splitMessage(text: string, maxLen = DISCORD_MAX_LEN): string[] {
  const prepared = tablesToCodeBlocks(text);
  if (prepared.length <= maxLen) return [prepared];

  const lines = prepared.split("\n");
  const chunks: string[] = [];
  let chunk: string[] = [];
  let chunkLen = 0;
  let openFence: string | null = null;
  let fenceMarkerLen = 0; // backtick/tilde count of the opening fence

  const CLOSE_FENCE_OVERHEAD = 4; // "```\n"

  for (const line of lines) {
    const lineLen = line.length + 1;
    const fenceMatch = line.trimStart().match(FENCE_RE);
    const matchedMarkerLen = fenceMatch ? fenceMatch[1].length : 0;
    const matchedChar = fenceMatch ? fenceMatch[1][0] : null;

    const isOpeningFence = fenceMatch && !openFence;
    const isClosingFence = fenceMatch && openFence
      && matchedChar === openFence[0]
      && matchedMarkerLen >= fenceMarkerLen
      && !fenceMatch[2]?.trim(); // closing fence has no info string

    if (isOpeningFence) {
      if (chunkLen + lineLen > maxLen && chunk.length > 0) {
        chunks.push(chunk.join("\n").trimEnd());
        chunk = [];
        chunkLen = 0;
      }
      openFence = line.trimStart();
      fenceMarkerLen = matchedMarkerLen;
      chunk.push(line);
      chunkLen += lineLen;
    } else if (isClosingFence) {
      chunk.push(line);
      chunkLen += lineLen;
      openFence = null;
      fenceMarkerLen = 0;

      if (chunkLen > maxLen && chunk.length > 0) {
        chunks.push(chunk.join("\n").trimEnd());
        chunk = [];
        chunkLen = 0;
      }
    } else if (openFence) {
      if (chunkLen + lineLen + CLOSE_FENCE_OVERHEAD > maxLen) {
        chunk.push("```");
        chunks.push(chunk.join("\n").trimEnd());
        chunk = [openFence];
        chunkLen = openFence.length + 1;
      }
      chunk.push(line);
      chunkLen += lineLen;
    } else {
      if (chunkLen + lineLen > maxLen && chunk.length > 0) {
        chunks.push(chunk.join("\n").trimEnd());
        chunk = [];
        chunkLen = 0;
      }
      chunk.push(line);
      chunkLen += lineLen;
    }
  }

  if (chunk.length > 0) {
    if (openFence) chunk.push("```");
    chunks.push(chunk.join("\n").trimEnd());
  }

  return chunks.filter(c => c.length > 0);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
