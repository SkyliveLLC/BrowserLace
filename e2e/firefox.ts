/**
 * Cross-browser run: a Chromium profile and a Firefox profile sync the same collection
 * both ways and send tabs to each other. Firefox is a separate download in a throwaway
 * profile, never your own:
 *
 *   npx @puppeteer/browsers install firefox@esr --path ~/Library/Caches/browserlace-e2e
 *   pnpm build
 *   FIREFOX_APP=<path to Firefox.app> pnpm --filter @browserlace/e2e firefox
 *
 * On macOS, Firefox is started through Launch Services (`open -n`) so it runs as its own
 * app, then driven over WebDriver BiDi. Use ESR (our minimum version, 140): newer releases
 * refuse BiDi navigation to moz-extension pages, so the harness can't open the extension.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { check, failed, launchChromium, startServer, unwrapReply } from "./harness.ts";

const firefoxApp = process.env.FIREFOX_APP;
if (!firefoxApp) throw new Error("Set FIREFOX_APP to a Firefox.app");
const ADDON_ID = process.env.WXT_FIREFOX_ADDON_ID || "browserlace@browserlace.app";
// Pinning the extension's internal UUID lets us open its pages by URL.
const UUID = "6f2c3c1e-6c4b-4f0e-9d7a-3b6a2f1e0c11";
const BIDI_PORT = 9333;
const root = new URL("..", import.meta.url).pathname;

const server = await startServer();
const a = await launchChromium("Chromium A");

const profile = mkdtempSync(join(tmpdir(), "bl-firefox-profile-"));
writeFileSync(join(profile, "user.js"), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: UUID }))});\n`);
execFileSync("open", ["-n", "-a", firefoxApp, "--args", "--headless", "--profile", profile, "--remote-debugging-port", String(BIDI_PORT)]);
let firefox: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
for (let i = 0; i < 50 && !firefox; i++) {
  firefox = await puppeteer
    .connect({ browserWSEndpoint: `ws://127.0.0.1:${BIDI_PORT}/session`, protocol: "webDriverBiDi" })
    .catch(() => new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)));
}
if (!firefox) throw new Error("Couldn't connect to Firefox");

/** Polls `read` until it returns something truthy, or fails after 15 s. */
async function eventually<T>(read: () => Promise<T>): Promise<T> {
  for (const started = Date.now(); Date.now() - started < 15_000; ) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return read();
}

try {
  await firefox.installExtension(join(root, "apps/extension/.output/firefox-mv3"));
  const f = await firefox.newPage();
  // Firefox's BiDi never reports moz-extension navigations as finished; wait for the page instead.
  await f.goto(`moz-extension://${UUID}/options.html`, { waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {});
  await eventually(() => f.evaluate(() => document.title === "BrowserLace settings").catch(() => false));
  const fcall = async (type: string, input?: unknown) =>
    unwrapReply(await f.evaluate((type, input) => browser.runtime.sendMessage({ type, input }), type, input as never));
  const fstorage = (key: string) => f.evaluate(async (key) => (await browser.storage.local.get(key))[key], key);
  const fbookmarks = (title: string) =>
    f.evaluate(async (title) => {
      const [folder] = await browser.bookmarks.search({ title });
      if (!folder) return [];
      const render = (n: browser.bookmarks.BookmarkTreeNode, d: number): string[] => [
        `${"  ".repeat(d)}${n.title}${n.url ? ` ${n.url}` : "/"}`,
        ...(n.children ?? []).flatMap((c) => render(c, d + 1)),
      ];
      const [tree] = await browser.bookmarks.getSubTree(folder.id);
      return (tree!.children ?? []).flatMap((c) => render(c, 0));
    }, title);

  // Chromium A sets up the account and a collection.
  await a.call("createAccount", { serverUrl: server.url, deviceName: "Chromium A" });
  await a.call("createCollection", { name: "Work", folder: "new", mode: "two-way" });
  await a.page.evaluate(async () => {
    const [folder] = await chrome.bookmarks.search({ title: "Work" });
    const docs = await chrome.bookmarks.create({ parentId: folder!.id, title: "Docs" });
    await chrome.bookmarks.create({ parentId: docs.id, title: "MDN", url: "https://developer.mozilla.org/" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "GitHub", url: "https://github.com/" });
  });
  await a.call("syncNow");

  // Firefox joins with a pairing link and syncs "Work" into a new folder.
  const { link } = (await a.call("createPairingCode")) as { link: string };
  await fcall("joinAccount", { serverUrl: "", code: link, deviceName: "Firefox F" });
  const [work] = (await fstorage("collections")) as { id: string }[];
  await fcall("mount", { collectionId: work!.id, folder: "new", mode: "two-way" });
  check("Firefox receives Chromium's bookmarks", await fbookmarks("Work"), await a.bookmarks("Work"));

  // Edits in Firefox reach Chromium live, without a manual sync there.
  await f.evaluate(async () => {
    const [folder] = await browser.bookmarks.search({ title: "Work" });
    await browser.bookmarks.create({ parentId: folder!.id, title: "From Firefox", url: "https://www.mozilla.org/" });
    const [gh] = await browser.bookmarks.search({ title: "GitHub" });
    await browser.bookmarks.update(gh!.id, { title: "GitHub (Firefox)" });
  });
  await fcall("syncNow");
  const expected = ["Docs/", "  MDN https://developer.mozilla.org/", "GitHub (Firefox) https://github.com/", "From Firefox https://www.mozilla.org/"];
  check("Chromium gets Firefox's edits live", await eventually(async () => {
    const lines = await a.bookmarks("Work");
    return JSON.stringify(lines) === JSON.stringify(expected) && lines;
  }), expected);

  // Tabs both ways.
  const aId = ((await a.storage("config")) as { deviceId: string }).deviceId;
  const fId = ((await fstorage("config")) as { deviceId: string }).deviceId;
  const toChromium = `${server.url}/healthz?from=firefox`;
  await fcall("sendTab", { toDeviceId: aId, url: toChromium, title: "From Firefox" });
  check("Chromium opens a tab sent from Firefox", await eventually(async () => a.context.pages().some((p) => p.url() === toChromium)), true);
  const toFirefox = `${server.url}/healthz?from=chromium`;
  await a.call("sendTab", { toDeviceId: fId, url: toFirefox, title: "From Chromium" });
  check(
    "Firefox opens a tab sent from Chromium",
    await eventually(async () => (await firefox.pages()).some((p) => p.url() === toFirefox)),
    true,
  );
} finally {
  await firefox.close().catch(() => {});
  await a.context.close();
  server.stop();
}
if (failed()) process.exit(1);
