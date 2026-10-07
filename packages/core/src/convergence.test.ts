import { expect, it } from "vitest";
import { Device, setup, type FakeBrowser } from "./testing.ts";

/** Small seeded PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

async function randomEdit(browser: FakeBrowser, random: () => number, label: string) {
  const all = [...browser.nodes.values()].filter((n) => n.id !== "root");
  const folders = [{ id: "root" }, ...all.filter((n) => n.url === undefined)];
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const isInside = (id: string, ancestor: string): boolean => {
    for (let cur: string | null = id; cur; cur = browser.nodes.get(cur)?.parentId ?? null) if (cur === ancestor) return true;
    return false;
  };
  const roll = random();
  if (roll < 0.35 || all.length === 0) {
    await browser.add(pick(folders).id, `bm-${label}`, `https://${label}.example`);
  } else if (roll < 0.5) {
    await browser.add(pick(folders).id, `folder-${label}`);
  } else if (roll < 0.65) {
    const node = pick(all);
    await browser.update(node.id, { title: `renamed-${label}`, ...(node.url ? { url: node.url } : {}) });
  } else if (roll < 0.85) {
    const node = pick(all);
    const target = pick(folders.filter((f) => !isInside(f.id, node.id)));
    const size = browser.nodes.get(target.id)!.children.filter((c) => c !== node.id).length;
    await browser.move(node.id, { parentId: target.id, index: Math.floor(random() * (size + 1)) });
  } else {
    await browser.removeTree(pick(all).id);
  }
}

it.each([1, 2, 3, 4, 5, 6, 7, 8])("three devices converge after random concurrent edits (seed %i)", async (seed) => {
  const random = rng(seed);
  const { server, keyring } = await setup();
  const devices = [new Device(server, keyring), new Device(server, keyring), new Device(server, keyring)];

  for (let round = 0; round < 12; round++) {
    for (const [i, device] of devices.entries()) {
      const edits = Math.floor(random() * 3);
      for (let e = 0; e < edits; e++) await randomEdit(device.browser, random, `${round}-${i}-${e}`);
      if (random() < 0.6) await device.sync({ allowDeletes: true });
    }
  }

  // Quiesce: keep syncing until a full round pushes nothing.
  for (let round = 0; round < 5; round++) {
    let pushed = 0;
    for (const device of devices) pushed += (await device.sync({ allowDeletes: true })).pushed;
    if (pushed === 0) break;
  }

  const [first, ...rest] = devices.map((d) => d.browser.outline());
  for (const outline of rest) expect(outline).toEqual(first);
});
