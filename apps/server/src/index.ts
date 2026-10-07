import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase(process.env.DATABASE_PATH ?? "browserlace.db");
const app = createApp({ db, signupToken: process.env.SIGNUP_TOKEN || undefined });

const server = serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`BrowserLace server listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
