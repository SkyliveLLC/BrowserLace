import { serve } from "@hono/node-server";
import { testClient } from "hono/testing";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { openDatabase, pruneHistory } from "./db.ts";

const LOOKUP = "a".repeat(43);

function setup(options: { signupToken?: string } = {}) {
  let time = 1_000_000;
  const db = openDatabase(":memory:");
  const app = createApp({ db, now: () => time, ...options });
  const client = testClient(app);
  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const signup = async () => {
    const res = await client.v1.accounts.$post({ json: { name: "Chrome on Mac", browser: "chrome" } });
    return res.json();
  };
  return { db, client, as, signup, advance: (ms: number) => (time += ms), now: () => time };
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
    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "wrapped", epoch: 1 } }, as(first.token));

    const claim = () => client.v1.pairings.claim.$post({ json: { lookupId: LOOKUP, name: "Safari", browser: "safari" } });
    const res = await claim();
    expect(res.status).toBe(201);
    const second = await res.json();
    expect(second).toMatchObject({ accountId: first.accountId, wrappedKey: "wrapped" });
    expect((await claim()).status).toBe(404);

    const me = await (await client.v1.me.$get({}, as(second.token))).json();
    expect(me.devices.map((d) => d.name)).toEqual(["Chrome on Mac", "Safari"]);

    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "again", epoch: 1 } }, as(first.token));
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

describe("keys", () => {
  const PUBLIC = "p".repeat(43);
  const PROOF = "q".repeat(43);
  const GRANT = `${"e".repeat(43)}.sealed`;

  it("asks for a new epoch after a device is removed, and lets only one device start it", async () => {
    const { client, as, signup } = setup();
    const first = await signup();
    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "wrapped", epoch: 1 } }, as(first.token));
    const second = await (await client.v1.pairings.claim.$post({ json: { lookupId: LOOKUP, name: "B", browser: "firefox" } })).json();
    for (const device of [first, second]) {
      await client.v1.devices.me.key.$put({ json: { publicKey: PUBLIC, proof: PROOF, proofEpoch: 1 } }, as(device.token));
    }
    const keys = () => client.v1.keys.$get({}, as(first.token)).then((r) => r.json());
    expect(await keys()).toMatchObject({ epoch: 1, rotationNeeded: false });

    await client.v1.devices[":id"].$delete({ param: { id: second.deviceId } }, as(first.token));
    expect((await keys()).rotationNeeded).toBe(true);

    const rotate = () =>
      client.v1.keys.$post(
        {
          json: {
            epoch: 2,
            grants: [
              { recipientId: first.deviceId, blob: GRANT },
              { recipientId: second.deviceId, blob: GRANT },
            ],
            attestations: [{ recipientId: first.deviceId, proof: PROOF }],
            metas: [],
          },
        },
        as(first.token),
      );
    expect((await rotate()).status).toBe(200);
    expect((await rotate()).status).toBe(409);
    expect(await keys()).toMatchObject({
      epoch: 2,
      rotationNeeded: false,
      grants: [{ epoch: 2, blob: GRANT }],
      holders: [{ id: first.deviceId, proofEpoch: 2 }],
    });
  });

  it("only registers keys attested under the current epoch", async () => {
    const { client, as, signup } = setup();
    const first = await signup();
    await client.v1.keys.$post({ json: { epoch: 2, grants: [], attestations: [], metas: [] } }, as(first.token));
    const register = (proofEpoch: number) =>
      client.v1.devices.me.key.$put({ json: { publicKey: PUBLIC, proof: PROOF, proofEpoch } }, as(first.token));

    expect((await register(1)).status).toBe(409);
    expect((await register(2)).status).toBe(200);
    expect((await register(2)).status).toBe(409);
  });

  it("refuses a rotation that leaves out a current device", async () => {
    const { client, as, signup } = setup();
    const first = await signup();
    await client.v1.devices.me.key.$put({ json: { publicKey: PUBLIC, proof: PROOF, proofEpoch: 1 } }, as(first.token));
    const rotate = (grants: { recipientId: string; blob: string }[]) =>
      client.v1.keys.$post({ json: { epoch: 2, grants, attestations: [], metas: [] } }, as(first.token));

    expect((await rotate([])).status).toBe(409);
    expect((await rotate([{ recipientId: first.deviceId, blob: GRANT }])).status).toBe(200);
  });

  it("won't redeem a pairing code made before a rotation", async () => {
    const { client, as, signup } = setup();
    const first = await signup();
    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "wrapped", epoch: 1 } }, as(first.token));
    await client.v1.keys.$post({ json: { epoch: 2, grants: [], attestations: [], metas: [] } }, as(first.token));

    const res = await client.v1.pairings.claim.$post({ json: { lookupId: LOOKUP, name: "Late", browser: "chrome" } });
    expect(res.status).toBe(409);
  });

  it("lets a recovery key sign in a new device and hands it the recovery grants", async () => {
    const { client, as, signup } = setup();
    const first = await signup();
    const setRecovery = (lookupId: string) =>
      client.v1.recovery.$put({ json: { lookupId, publicKey: PUBLIC, proof: PROOF, proofEpoch: 1, epoch: 1, grant: GRANT } }, as(first.token));
    await setRecovery("r".repeat(43));
    expect((await (await client.v1.keys.$get({}, as(first.token))).json()).rotationNeeded).toBe(false);
    await setRecovery(LOOKUP);
    // The replaced key can still open the current epoch's grant.
    expect((await (await client.v1.keys.$get({}, as(first.token))).json()).rotationNeeded).toBe(true);

    const claim = (lookupId: string) => client.v1.recovery.claim.$post({ json: { lookupId, name: "New", browser: "chrome" } });
    expect((await claim("r".repeat(43))).status).toBe(404);
    const res = await claim(LOOKUP);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ accountId: first.accountId, grants: [{ epoch: 1, blob: GRANT }] });
  });
});

describe("profiles", () => {
  it("stores profiles per account and won't let another account overwrite one", async () => {
    const { client, as, signup } = setup();
    const owner = await signup();
    const stranger = await signup();
    const id = randomUUID();
    const put = (token: string, blob: string) => client.v1.profiles[":id"].$put({ param: { id }, json: { blob } }, as(token));

    expect((await put(owner.token, "v1")).status).toBe(200);
    expect((await put(owner.token, "v2")).status).toBe(200);
    expect((await put(stranger.token, "mine")).status).toBe(404);

    const list = async (token: string) => (await (await client.v1.profiles.$get({}, as(token))).json()).profiles;
    expect(await list(owner.token)).toEqual([expect.objectContaining({ id, blob: "v2" })]);
    expect(await list(stranger.token)).toEqual([]);
  });
});

describe("sends", () => {
  it("delivers a tab to one device of the same account until it's acknowledged", async () => {
    const { client, as, signup } = setup();
    const from = await signup();
    await client.v1.pairings.$post({ json: { lookupId: LOOKUP, wrappedKey: "wrapped", epoch: 1 } }, as(from.token));
    const to = await (await client.v1.pairings.claim.$post({ json: { lookupId: LOOKUP, name: "B", browser: "firefox" } })).json();
    const stranger = await signup();
    const id = randomUUID();

    const send = (token: string, toDeviceId: string) => client.v1.sends.$post({ json: { id: randomUUID(), toDeviceId, blob: "tab" } }, as(token));
    expect((await send(stranger.token, to.deviceId)).status).toBe(404);
    await client.v1.sends.$post({ json: { id, toDeviceId: to.deviceId, blob: "tab" } }, as(from.token));

    const inbox = async (token: string) => (await (await client.v1.sends.$get({}, as(token))).json()).sends;
    expect(await inbox(to.token)).toEqual([expect.objectContaining({ id, fromDeviceId: from.deviceId, blob: "tab" })]);
    expect(await inbox(from.token)).toEqual([]);
    await client.v1.sends[":id"].$delete({ param: { id } }, as(to.token));
    expect(await inbox(to.token)).toEqual([]);
  });
});

describe("live events", () => {
  it("tells an account's other connections what changed, and nobody else", async () => {
    const db = openDatabase(":memory:");
    const app = createApp({ db });
    const server = serve({ fetch: app.fetch, port: 0, websocket: { server: new WebSocketServer({ noServer: true }) } });
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const signup = () =>
      fetch(`${base}/v1/accounts`, { method: "POST", body: JSON.stringify({ name: "A", browser: "chrome" }), headers: { "content-type": "application/json" } })
        .then((r) => r.json() as Promise<{ token: string; deviceId: string }>);
    const listen = async (token: string) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/v1/events`);
      const received: unknown[] = [];
      socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
      await new Promise((resolve) => socket.addEventListener("open", resolve));
      socket.send(JSON.stringify({ token }));
      await vi.waitFor(() => expect(received).toEqual([{ type: "ready" }]));
      return { socket, received };
    };

    const owner = await signup();
    const stranger = await signup();
    const mine = await listen(owner.token);
    const theirs = await listen(stranger.token);
    await fetch(`${base}/v1/tabs`, {
      method: "PUT",
      body: JSON.stringify({ blob: "tabs" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    });

    await vi.waitFor(() => expect(mine.received).toContainEqual({ type: "tabs", from: owner.deviceId }));
    expect(theirs.received).toEqual([{ type: "ready" }]);

    const rejected = new WebSocket(`${base.replace("http", "ws")}/v1/events`);
    await new Promise((resolve) => rejected.addEventListener("open", resolve));
    rejected.send(JSON.stringify({ token: "nope" }));
    const code = await new Promise((resolve) => rejected.addEventListener("close", (e) => resolve(e.code)));
    expect(code).toBe(4001);

    mine.socket.close();
    theirs.socket.close();
    server.close();
  });
});

describe("snapshots and retention", () => {
  it("prunes old changes a snapshot covers, and sends older cursors to the snapshot", async () => {
    const { db, client, as, signup, advance, now } = setup();
    const { token } = await signup();
    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(token));
    const push = (head: number) => client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob: `c${head}`, head } }, as(token));
    for (let head = 0; head < 3; head++) await push(head);
    const snapshot = (seq: number, blob: string) => client.v1.collections[":id"].snapshot.$put({ param: { id }, json: { seq, blob } }, as(token));

    expect((await snapshot(4, "ahead")).status).toBe(400);
    await snapshot(2, "at2");
    await snapshot(1, "older");
    expect(await (await client.v1.collections[":id"].snapshot.$get({ param: { id } }, as(token))).json()).toEqual({ snapshot: { seq: 2, blob: "at2" } });

    advance(1000);
    await push(3);
    expect(pruneHistory(db, now() - 500)).toBe(2);

    const pull = (after: number) => client.v1.collections[":id"].changes.$get({ param: { id }, query: { after: String(after) } }, as(token));
    expect((await pull(0)).status).toBe(410);
    expect((await (await pull(2)).json()).changes.map((c) => c.seq)).toEqual([3, 4]);
    expect((await push(4)).status).toBe(201);
    const { collections } = await (await client.v1.collections.$get({}, as(token))).json();
    expect(collections[0]).toMatchObject({ headSeq: 5, snapshotSeq: 2 });
  });

  it("keeps changing after the whole log is pruned", async () => {
    const { db, client, as, signup, advance, now } = setup();
    const { token } = await signup();
    const id = randomUUID();
    await client.v1.collections.$post({ json: { id, meta: "meta" } }, as(token));
    await client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob: "c0", head: 0 } }, as(token));
    await client.v1.collections[":id"].snapshot.$put({ param: { id }, json: { seq: 1, blob: "s" } }, as(token));
    advance(1000);
    pruneHistory(db, now());

    const push = await client.v1.collections[":id"].changes.$post({ param: { id }, json: { blob: "c1", head: 1 } }, as(token));
    expect(await push.json()).toEqual({ seq: 2 });
  });
});
