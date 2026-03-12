import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";

let applied = false;

export function setupProxy(proxyUrl?: string): void {
  if (!proxyUrl || applied) return;
  applied = true;

  const agent = new HttpsProxyAgent(proxyUrl);
  const req = createRequire(import.meta.url);

  // Patch undici instance that @discordjs/rest resolves to (its own bundled copy).
  try {
    const restEntry = req.resolve("@discordjs/rest");
    const restRequire = createRequire(restEntry);
    const undici = restRequire("undici") as typeof import("undici");
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
  } catch (e: any) {
    console.error(`[pi-relay] Failed to patch undici:`, e.message);
  }

  // Patch ws module in require cache BEFORE @discordjs/ws imports it.
  // @discordjs/ws captures `WebSocket` at import time, so we must modify
  // the cached module.exports before discord.js is first loaded.
  try {
    const wsExports = req("ws");
    const OrigWebSocket = wsExports.WebSocket;
    const Patched = function (this: any, url: any, protocols: any, opts: any) {
      return new OrigWebSocket(url, protocols, { ...opts, agent });
    } as any;
    Patched.prototype = OrigWebSocket.prototype;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== "prototype" && key !== "length" && key !== "name") {
        try { Patched[key] = OrigWebSocket[key]; } catch {}
      }
    }
    wsExports.WebSocket = Patched;
  } catch (e: any) {
    console.error(`[pi-relay] Failed to patch ws:`, e.message);
  }

  console.log(`[pi-relay] Proxy enabled: ${proxyUrl}`);
}
