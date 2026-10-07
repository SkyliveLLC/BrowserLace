import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { Events } from "./events.ts";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase(process.env.DATABASE_PATH ?? "browserlace.db");
const events = new Events();
const app = createApp({ db, events, signupToken: process.env.SIGNUP_TOKEN || undefined });

const server = serve({ fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } }, ({ port }) => {
  console.log(`BrowserLace server listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    events.closeAll();
    server.close();
    db.close();
    process.exit(0);
  });
}
