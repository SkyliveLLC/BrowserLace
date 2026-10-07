/**
 * One WebSocket to the server for live events, so a change on another device syncs here
 * in about a second instead of on the next alarm. Best effort: if the socket drops (or a
 * browser unloads the background), it reconnects with backoff and the 1-minute alarm
 * calls `ensureLive` again.
 */
import type { ServerEvent } from "@browserlace/server";
import { configItem } from "./storage.ts";

// Chrome keeps an extension service worker alive while its WebSocket is active (Chrome 116+).
const KEEPALIVE_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

let socket: WebSocket | undefined;
let socketKey: string | undefined;
let keepalive: ReturnType<typeof setInterval> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function close() {
  clearInterval(keepalive);
  clearTimeout(reconnect);
  const old = socket;
  socket = undefined;
  socketKey = undefined;
  old?.close();
}

/** Opens the socket if it isn't open for the current config, or closes it when signed out. */
export async function ensureLive(onEvent: (event: ServerEvent) => void) {
  const config = await configItem.getValue();
  if (!config) return close();
  const key = `${config.serverUrl}|${config.token}`;
  if (socket && socketKey === key && socket.readyState <= WebSocket.OPEN) return;
  close();

  const ws = new WebSocket(`${config.serverUrl.replace(/^http/, "ws")}/v1/events`);
  socket = ws;
  socketKey = key;
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ token: config.token }));
    keepalive = setInterval(() => ws.send("ping"), KEEPALIVE_MS);
  });
  ws.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as ServerEvent | { type: "ready" };
    if (event.type === "ready") failures = 0;
    else if (event.from !== config.deviceId) onEvent(event);
  });
  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    clearInterval(keepalive);
    socket = undefined;
    // 4001: revoked. The next sync reports that; don't hammer the server.
    if (event.code === 4001) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures++);
    reconnect = setTimeout(() => void ensureLive(onEvent), delay);
  });
}
