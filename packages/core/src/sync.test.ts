import { describe, expect, it } from "vitest";
import { generateKey, importKeyring, MissingKeyError, mergeKeyring } from "./crypto.ts";
import { restoreCollection, TamperError, type MountMode } from "./sync.ts";
import { Device, setup } from "./testing.ts";

async function pair(mode: MountMode = "two-way") {
  const { server, keyring } = await setup();
  return { server, keyring, a: new Device(server, keyring), b: new Device(server, keyring, mode) };
}

describe("syncCollection", () => {
  it("replicates nested folders and order to another browser", async () => {
    const { a, b } = await pair();
    const dev = await a.browser.add("root", "Dev");
    await a.browser.add(dev, "GitHub", "https://github.com");
    await a.browser.add(dev, "MDN", "https://developer.mozilla.org");
    await a.browser.add("root", "News", "https://news.ycombinator.com");

    await a.sync();
    await b.sync();

    expect(b.browser.outline()).toEqual(a.browser.outline());
    expect(b.browser.outline()).toEqual([
      "Dev/",
      "  GitHub https://github.com",
      "  MDN https://developer.mozilla.org",
      "News https://news.ycombinator.com",
    ]);
  });

  it("pushes nothing when nothing changed", async () => {
    const { a, b } = await pair();
    await a.browser.add("root", "GitHub", "https://github.com");
    await a.sync();
    await b.sync();

    expect((await a.sync()).pushed).toBe(0);
    expect((await b.sync()).pushed).toBe(0);
  });

  it("keeps concurrent edits to different fields of the same bookmark", async () => {
    const { a, b } = await pair();
    await a.browser.add("root", "Folder");
    await a.browser.add("root", "Docs", "https://docs.example");
    await a.sync();
    await b.sync();

    await a.browser.update(a.browser.find("Docs"), { title: "Renamed", url: "https://docs.example" });
    await b.browser.move(b.browser.find("Docs"), { parentId: b.browser.find("Folder") });
    await a.sync();
    await b.sync();
    await a.sync();

    const expected = ["Folder/", "  Renamed https://docs.example"];
    expect(a.browser.outline()).toEqual(expected);
    expect(b.browser.outline()).toEqual(expected);
  });

  it("propagates reorders without losing a concurrent insert", async () => {
    const { a, b } = await pair();
    for (const name of ["one", "two", "three"]) await a.browser.add("root", name, `https://${name}.example`);
    await a.sync();
    await b.sync();

    await a.browser.move(a.browser.find("three"), { parentId: "root", index: 0 });
    await b.browser.add("root", "four", "https://four.example");
    await a.sync();
    await b.sync();
    await a.sync();

    const titles = (d: Device) => d.browser.outline().map((l) => l.split(" ")[0]);
    expect(titles(a)).toEqual(["three", "one", "two", "four"]);
    expect(titles(b)).toEqual(titles(a));
  });

  it("propagates a deleted folder with its contents", async () => {
    const { a, b } = await pair();
    const old = await a.browser.add("root", "Old");
    await a.browser.add(old, "Stale", "https://stale.example");
    await a.browser.add("root", "Keep", "https://keep.example");
    await a.sync();
    await b.sync();

    await a.browser.removeTree(a.browser.find("Old"));
    await a.sync();
    await b.sync();

    expect(b.browser.outline()).toEqual(["Keep https://keep.example"]);
  });

  it("pauses a mass delete until the user confirms it", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 20; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    for (let i = 0; i < 15; i++) await a.browser.removeTree(a.browser.find(`b${i}`));
    expect((await a.sync()).paused).toEqual({ reason: "local-deletes", count: 15 });
    await b.sync();
    expect(b.browser.outline()).toHaveLength(20);

    await a.sync({ allowDeletes: true });
    expect((await b.sync()).paused).toEqual({ reason: "remote-deletes", count: 15 });
    await b.sync({ allowDeletes: true });
    expect(b.browser.outline()).toHaveLength(5);
  });

  it("puts paused local deletes back when the baseline is cleared", async () => {
    const { a, server } = await pair();
    for (let i = 0; i < 20; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    const before = a.browser.outline();

    for (let i = 0; i < 15; i++) await a.browser.removeTree(a.browser.find(`b${i}`));
    expect((await a.sync()).paused?.reason).toBe("local-deletes");
    a.mountState = { ...a.mountState, baseline: {} };
    expect((await a.sync()).pushed).toBe(0);

    expect(a.browser.outline()).toEqual(before);
    expect(server.logs.get("c1")).toHaveLength(1);
  });

  it("re-adopts deleted bookmarks the user re-created instead of duplicating them", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 20; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    // e.g. undo in the bookmark manager, or re-importing an export: same bookmarks, new ids.
    for (let i = 0; i < 12; i++) await a.browser.removeTree(a.browser.find(`b${i}`));
    expect((await a.sync()).paused?.reason).toBe("local-deletes");
    for (let i = 0; i < 12; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    expect(a.browser.outline()).toHaveLength(20);
    expect(b.browser.outline()).toHaveLength(20);
  });

  it("puts deletes back without dropping other local edits", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 20; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    for (let i = 0; i < 15; i++) await a.browser.removeTree(a.browser.find(`b${i}`));
    await a.browser.update(a.browser.find("b19"), { title: "renamed", url: "https://b19.example" });
    await a.sync({ discardDeletes: true });
    await b.sync();

    expect(a.browser.outline()).toHaveLength(20);
    expect(b.browser.outline()).toContain("renamed https://b19.example");
    expect(b.browser.outline()).toHaveLength(20);
  });

  it("doesn't re-push local edits while paused on remote deletes", async () => {
    const { a, b, server } = await pair();
    for (let i = 0; i < 20; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    for (let i = 0; i < 15; i++) await a.browser.removeTree(a.browser.find(`b${i}`));
    await a.sync({ allowDeletes: true });
    await b.browser.update(b.browser.find("b19"), { title: "from B", url: "https://b19.example" });
    expect(await b.sync()).toMatchObject({ pushed: 1, paused: { reason: "remote-deletes" } });
    const logLength = server.logs.get("c1")!.length;
    expect((await b.sync()).pushed).toBe(0);
    expect(server.logs.get("c1")).toHaveLength(logLength);
  });

  it("re-diffs instead of duplicating when another device pushes first", async () => {
    const { a, b, server } = await pair();
    await a.browser.add("root", "GH", "https://github.com");
    await b.browser.add("root", "GH", "https://github.com");

    server.beforePush = async () => void (await a.sync());
    await b.sync();
    await a.sync();

    expect(a.browser.outline()).toEqual(["GH https://github.com"]);
    expect(b.browser.outline()).toEqual(["GH https://github.com"]);
  });

  it("matches bookmarks by URL across folders when mounting", async () => {
    const { a, b } = await pair();
    const dev = await a.browser.add("root", "Dev");
    await a.browser.add(dev, "GH", "https://github.com");
    await a.sync();
    const renamed = await b.browser.add("root", "Development");
    await b.browser.add(renamed, "GH", "https://github.com");
    await b.sync();
    await a.sync();

    for (const device of [a, b]) {
      expect(device.browser.outline().filter((line) => line.includes("github"))).toHaveLength(1);
    }
  });

  it("keeps edits the user makes while a sync is applying changes", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 3; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();
    await b.sync();

    await a.browser.add("root", "new", "https://new.example");
    await a.sync();
    b.browser.afterWrite = () => b.browser.update(b.browser.find("b0"), { title: "edited mid-sync", url: "https://b0.example" });
    await b.sync();
    await b.sync();
    await a.sync();

    expect(a.browser.outline()[0]).toBe("edited mid-sync https://b0.example");
  });

  it("skips a change it can't read instead of stalling the collection", async () => {
    const { a, b, server } = await pair();
    await a.browser.add("root", "one", "https://one.example");
    await a.sync();
    await server.push("c1", "bm90LWEtcmVhbC1jaGFuZ2U", server.logs.get("c1")!.length);
    await a.browser.add("root", "two", "https://two.example");
    await a.sync();

    expect((await b.sync()).unreadable).toBe(1);
    expect(b.browser.outline()).toEqual(["one https://one.example", "two https://two.example"]);
  });

  it("stops when the server reorders changes", async () => {
    const { a, b, server } = await pair();
    await a.browser.add("root", "one", "https://one.example");
    await a.sync();
    await a.browser.add("root", "two", "https://two.example");
    await a.sync();

    const [first, second] = server.logs.get("c1")!;
    [first!.blob, second!.blob] = [second!.blob, first!.blob];
    await expect(b.sync()).rejects.toThrow(TamperError);
  });

  it("stops when the server replays an old change", async () => {
    const { a, b, server } = await pair();
    await a.browser.add("root", "one", "https://one.example");
    await a.sync();
    await b.sync();

    const log = server.logs.get("c1")!;
    log.push({ ...log[0]!, seq: 2 });
    await expect(b.sync()).rejects.toThrow(TamperError);
  });

  it("waits for a key it doesn't have yet instead of skipping the change", async () => {
    const { server, keyring, a } = await pair();
    const epoch2 = await importKeyring(mergeKeyring(keyring.stored, { 2: generateKey() }));
    const b = new Device(server, epoch2);
    await b.browser.add("root", "new key", "https://new.example");
    await b.sync();

    await expect(a.sync()).rejects.toThrow(MissingKeyError);
    expect(a.collection.cursor).toBe(0);
  });

  it("send-only: the folder wins, and other devices' edits are reverted", async () => {
    const { a, b } = await pair("send");
    await b.browser.add("root", "Docs", "https://docs.example");
    await b.sync();
    await a.sync();

    await a.browser.update(a.browser.find("Docs"), { title: "Renamed on A", url: "https://docs.example" });
    await a.browser.add("root", "Added on A", "https://a.example");
    await a.sync();
    await b.browser.add("root", "Added on B", "https://b.example");
    await b.sync();
    await a.sync();

    expect(b.browser.outline()).toEqual(["Docs https://docs.example", "Added on B https://b.example"]);
    expect(a.browser.outline()).toEqual(b.browser.outline());
  });

  it("adopts matching bookmarks instead of duplicating them on first mount", async () => {
    const { a, b } = await pair();
    for (const browser of [a.browser, b.browser]) {
      const dev = await browser.add("root", "Dev");
      await browser.add(dev, "GitHub", "https://github.com");
    }
    await b.browser.add("root", "Only on B", "https://b.example");

    await a.sync();
    await b.sync();
    await a.sync();

    const expected = ["Dev/", "  GitHub https://github.com", "Only on B https://b.example"];
    expect(a.browser.outline()).toEqual(expected);
    expect(b.browser.outline()).toEqual(expected);
  });

  it("receive-only mounts mirror the collection and never push", async () => {
    const { a, b, server } = await pair("receive");
    await a.browser.add("root", "Shared", "https://shared.example");
    await a.sync();
    await b.sync();

    await b.browser.add("root", "Local only", "https://local.example");
    await b.browser.update(b.browser.find("Shared"), { title: "Edited", url: "https://shared.example" });
    await b.sync();

    expect(b.browser.outline()).toEqual(["Shared https://shared.example"]);
    expect(server.logs.get("c1")).toHaveLength(1);
  });

  it("pauses instead of deleting everything when the mounted folder disappears", async () => {
    const { a, b, server } = await pair();
    a.folderId = await a.browser.add("root", "Mounted");
    await a.browser.add(a.folderId, "Thing", "https://thing.example");
    await a.sync();

    await a.browser.removeTree(a.folderId);
    expect((await a.sync()).paused).toEqual({ reason: "folder-missing" });
    expect(server.logs.get("c1")).toHaveLength(1);
    await b.sync();
    expect(b.browser.outline()).toEqual(["Thing https://thing.example"]);
  });

  it("recovers from a crash mid-apply without duplicating bookmarks", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 5; i++) await a.browser.add("root", `b${i}`, `https://b${i}.example`);
    await a.sync();

    // The worker dies after two bookmarks were created: nothing from that pass is persisted.
    const persisted = { collection: b.collection, mountState: b.mountState };
    b.browser.failAfterWrites = 2;
    await b.sync();
    Object.assign(b, persisted);
    b.browser.failAfterWrites = Infinity;
    await b.sync();
    await a.sync();

    expect(b.browser.outline()).toEqual(a.browser.outline());
    expect(a.browser.outline()).toHaveLength(5);
  });

  it("skips bookmarks a browser refuses without treating them as deleted", async () => {
    const { a, b } = await pair();
    await a.browser.add("root", "Bookmarklet", "javascript:alert(1)");
    await a.browser.add("root", "Normal", "https://normal.example");
    b.browser.rejectUrl = (url) => url.startsWith("javascript:");

    await a.sync();
    expect((await b.sync()).skipped).toBe(1);
    expect((await b.sync()).pushed).toBe(0);
    await a.sync();

    expect(b.browser.outline()).toEqual(["Normal https://normal.example"]);
    expect(a.browser.outline()).toEqual(["Bookmarklet javascript:alert(1)", "Normal https://normal.example"]);
  });

  it("restores a collection to before a change", async () => {
    const { a, b, server, keyring } = await pair();
    const folder = await a.browser.add("root", "Research");
    await a.browser.add(folder, "Paper", "https://paper.example");
    await a.sync();
    const before = server.logs.get("c1")!.length + 1;

    await a.browser.removeTree(a.browser.find("Research"));
    await a.browser.add("root", "Later", "https://later.example");
    await a.sync();

    await restoreCollection({ collectionId: "c1", keyring, transport: server, beforeSeq: before });
    await a.sync();
    await b.sync();

    const expected = ["Research/", "  Paper https://paper.example"];
    expect(a.browser.outline()).toEqual(expected);
    expect(b.browser.outline()).toEqual(expected);
  });
});
