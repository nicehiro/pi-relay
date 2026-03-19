import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { DiscordClient } from "./discord.js";

/**
 * Create an ExtensionUIContext backed by Discord buttons/messages.
 *
 * confirm() and select() use interactive Discord buttons.
 * notify() sends messages to the thread.
 * TUI-only methods are no-ops.
 */
export function createDiscordUIContext(
  threadId: string,
  discord: DiscordClient,
): ExtensionUIContext {
  const noop = () => {};

  const ctx: Partial<ExtensionUIContext> = {
    async select(title, options, opts) {
      return discord.sendSelect(threadId, title, options, {
        timeout: opts?.timeout,
        signal: opts?.signal,
      });
    },

    async confirm(title, message, opts) {
      return discord.sendConfirmation(threadId, title, message, {
        timeout: opts?.timeout,
        signal: opts?.signal,
      });
    },

    async input() {
      return undefined;
    },

    notify(message, type) {
      const prefix = type === "error" ? "❌ " : type === "warning" ? "⚠️ " : "";
      discord.sendMessage(threadId, `${prefix}${message}`).catch(() => {});
    },

    onTerminalInput() {
      return noop;
    },

    setStatus: noop,
    setWorkingMessage: noop,
    setWidget: noop as any,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText() {
      return "";
    },
    async editor() {
      return undefined;
    },
    setEditorComponent: noop,
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded: noop,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Not available in Discord" };
    },
    async custom() {
      return undefined as any;
    },
  };

  return ctx as ExtensionUIContext;
}
