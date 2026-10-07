import { testClient } from "hono/testing";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { stripeBilling, type Plans } from "./billing.ts";
import { openDatabase } from "./db.ts";

const WEBHOOK_SECRET = "whsec_test";
const tiny: Plans = {
  free: { devices: 1, collections: 1, storageBytes: 100 },
  plus: { devices: 5, collections: 5, storageBytes: 10_000 },
};

/** A server with Stripe billing whose API calls hit `stripeApi` instead of Stripe. */
function setup() {
  const subscriptions = new Map<string, { status: string; accountId: string }>();
  const cancelled: string[] = [];
  const stripeApi: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const id = url.pathname.split("/").at(-1)!;
    if (init?.method === "DELETE") cancelled.push(id);
    const sub = subscriptions.get(id)!;
    const body = { id, object: "subscription", customer: "cus_1", status: sub.status, metadata: { accountId: sub.accountId } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const provider = stripeBilling({ secretKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET, priceId: "price_1", publicUrl: "https://bl.test", fetch: stripeApi });
  const app = createApp({ db: openDatabase(":memory:"), billing: { provider, plans: tiny } });
  const client = testClient(app);
  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  /** Sends a signed `customer.subscription.updated` event, with Stripe holding `status`. */
  const webhook = async (accountId: string, status: string, secret = WEBHOOK_SECRET) => {
    subscriptions.set("sub_1", { status, accountId });
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1", object: "subscription" } } });
    const signature = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload, secret });
    return app.request("/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } });
  };
  return { client, as, webhook, cancelled };
}

describe("billing", () => {
  it("enforces the free plan and lifts the limits once Stripe says the subscription is active", async () => {
    const { client, as, webhook } = setup();
    const { token, accountId } = await (await client.v1.accounts.$post({ json: { name: "A", browser: "chrome" } })).json();
    const createCollection = () => client.v1.collections.$post({ json: { id: randomUUID(), meta: "meta" } }, as(token));

    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(token));
    expect((await createCollection()).status).toBe(402);
    const push = (blob: string, head: number) => client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob, head } }, as(token));
    expect((await push("x".repeat(500), 0)).status).toBe(402);

    expect((await webhook(accountId, "active")).status).toBe(200);
    expect((await createCollection()).status).toBe(201);
    expect((await push("x".repeat(500), 0)).status).toBe(201);
    const account = await (await client.v1.account.$get({}, as(token))).json();
    expect(account).toMatchObject({ plan: "plus", status: "active", billingEnabled: true, canManageBilling: true, usage: { collections: 2 } });

    await webhook(accountId, "canceled");
    expect((await (await client.v1.account.$get({}, as(token))).json()).plan).toBe("free");
  });

  it("rejects webhooks without a valid signature", async () => {
    const { client, webhook } = setup();
    const { accountId } = await (await client.v1.accounts.$post({ json: { name: "A", browser: "chrome" } })).json();
    expect((await webhook(accountId, "active", "whsec_wrong")).status).toBe(400);
  });

  it("deletes the account everywhere and cancels its subscription", async () => {
    const { client, as, webhook, cancelled } = setup();
    const { token, accountId } = await (await client.v1.accounts.$post({ json: { name: "A", browser: "chrome" } })).json();
    await webhook(accountId, "active");

    expect((await client.v1.account.$delete({}, as(token))).status).toBe(200);
    expect(cancelled).toEqual(["sub_1"]);
    expect((await client.v1.me.$get({}, as(token))).status).toBe(401);
  });
});

describe("without billing", () => {
  it("has no limits", async () => {
    const client = testClient(createApp({ db: openDatabase(":memory:") }));
    const { token } = await (await client.v1.accounts.$post({ json: { name: "A", browser: "chrome" } })).json();
    const account = await (await client.v1.account.$get({}, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(account).toMatchObject({ plan: "free", billingEnabled: false, limits: null });
  });
});
