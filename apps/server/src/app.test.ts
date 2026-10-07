import { testClient } from "hono/testing";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const LOOKUP = "a".repeat(43);

function setup(options: { signupToken?: string } = {}) {
  let time = 1_000_000;
  const app = createApp({ db: openDatabase(":memory:"), now: () => time, ...options });
  const client = testClient(app);
  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const signup = async () => {
    const res = await client.v1.accounts.$post({ json: { name: "Chrome on Mac", browser: "chrome" } });
    return res.json();
  };
  return { client, as, signup, advance: (ms: number) => (time += ms) };
}

describe("accounts and devices", () => {
  it("rejects requests without a valid token", async () => {
    const { client, as } = setup();
    expect((await client.v1.me.$get({}, as("nope"))).status).toBe(401);
  });

  it("requires the signup token when configured", async () => {
    const { client } = setup({ signupToken: "letmein" });
    const body = { name: "Firefox", browser: "firefox" };
    expect((await client.v1.accounts.$post({ json: body })).status).toBe(403);
    expect((await client.v1.accounts.$post({ json: { ...body, signupToken: "letmein" } })).status).toBe(201);
  });

  it("pairs a second device once, within the time limit", async () => {
    const { client, as, signup, advance } = setup();
    const first = await signup();
    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "wrapped" } }, as(first.token));

    const claim = () => client.v1.pairings.claim.$post({ json: { lookupId: LOOKUP, name: "Safari", browser: "safari" } });
    const res = await claim();
    expect(res.status).toBe(201);
    const second = await res.json();
    expect(second).toMatchObject({ accountId: first.accountId, wrappedKey: "wrapped" });
    expect((await claim()).status).toBe(404);

    const me = await (await client.v1.me.$get({}, as(second.token))).json();
    expect(me.devices.map((d) => d.name)).toEqual(["Chrome on Mac", "Safari"]);

    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "again" } }, as(first.token));
    advance(11 * 60 * 1000);
    expect((await claim()).status).toBe(404);
  });

  it("revokes a device's token when it is removed", async () => {
    const { client, as, signup } = setup();
    const { token, deviceId } = await signup();
    await client.v1.devices[":id"].$delete({ param: { id: deviceId } }, as(token));
    expect((await client.v1.me.$get({}, as(token))).status).toBe(401);
  });
});

describe("collections", () => {
  it("orders changes and pages through them", async () => {
    const { client, as, signup } = setup();
    const { token } = await signup();
    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(token));
    for (let i = 0; i < 502; i++) {
      await client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob: `c${i}`, head: i } }, as(token));
    }

    const page = (after: number) =>
      client.v1.collections[":id"].changes.$get({ param: { id }, query: { after: String(after) } }, as(token)).then((r) => r.json());
    const first = await page(0);
    expect(first.changes).toHaveLength(500);
    expect(first.more).toBe(true);
    expect(first.changes[0]).toMatchObject({ seq: 1, blob: "c0" });
    const rest = await page(500);
    expect(rest.changes.map((c) => c.seq)).toEqual([501, 502]);
    expect(rest.more).toBe(false);

    const { collections } = await (await client.v1.collections.$get({}, as(token))).json();
    expect(collections).toEqual([expect.objectContaining({ id, meta: "meta", headSeq: 502 })]);
  });

  it("rejects a push based on a stale head", async () => {
    const { client, as, signup } = setup();
    const { token } = await signup();
    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(token));
    const push = (head: number) =>
      client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob: "change", head } }, as(token));

    expect((await push(0)).status).toBe(201);
    expect((await push(0)).status).toBe(409);
    expect((await push(1)).status).toBe(201);
  });

  it("hides collections from other accounts", async () => {
    const { client, as, signup } = setup();
    const owner = await signup();
    const stranger = await signup();
    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(owner.token));

    const res = await client.v1.collections[":id"].changes.$get({ param: { id }, query: {} }, as(stranger.token));
    expect(res.status).toBe(404);
    expect((await client.v1.collections.$post({ json: { id, meta: "x" } }, as(stranger.token))).status).toBe(409);
  });
});

describe("tabs", () => {
  it("shares each device's latest snapshot within the account", async () => {
    const { client, as, signup } = setup();
    const { token, deviceId } = await signup();
    await client.v1.tabs.$put({ json: { blob: "old" } }, as(token));
    await client.v1.tabs.$put({ json: { blob: "new" } }, as(token));

    const { tabs } = await (await client.v1.tabs.$get({}, as(token))).json();
    expect(tabs).toEqual([expect.objectContaining({ deviceId, blob: "new" })]);
    const other = await signup();
    expect((await (await client.v1.tabs.$get({}, as(other.token))).json()).tabs).toEqual([]);
  });
});
