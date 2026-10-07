import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { plansFromEnv, stripeBilling } from "./billing.ts";
import { openDatabase, pruneHistory } from "./db.ts";
import { Events } from "./events.ts";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase(process.env.DATABASE_PATH ?? "browserlace.db");
const events = new Events();
const historyDays = Number(process.env.HISTORY_DAYS ?? 365);

// Daily: drop changes older than HISTORY_DAYS that a snapshot covers.
const prune = () => {
  const dropped = pruneHistory(db, Date.now() - historyDays * 24 * 60 * 60 * 1000);
  if (dropped > 0) console.log(`Pruned ${dropped} old changes`);
};
prune();
const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, PUBLIC_URL } = process.env;
// Billing (and plan limits) only when every Stripe setting is present: the hosted service, not self-hosting.
const billing =
  STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && STRIPE_PRICE_ID && PUBLIC_URL
    ? {
        provider: stripeBilling({
          secretKey: STRIPE_SECRET_KEY,
          webhookSecret: STRIPE_WEBHOOK_SECRET,
          priceId: STRIPE_PRICE_ID,
          publicUrl: PUBLIC_URL.replace(/\/+$/, ""),
        }),
        plans: plansFromEnv(process.env),
      }
    : undefined;
const app = createApp({ db, events, billing, signupToken: process.env.SIGNUP_TOKEN || undefined });
if (billing) console.log("Billing enabled");

const server = serve({ fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } }, ({ port }) => {
  console.log(`BrowserLace server listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(pruneTimer);
    events.closeAll();
    server.close();
    db.close();
    process.exit(0);
  });
}
