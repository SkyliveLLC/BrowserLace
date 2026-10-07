/**
 * Helpers for the end-to-end runs: a throwaway server and isolated Chromium profiles with
 * the built extension. Never touches your own browser profiles.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
export const shots = mkdtempSync(join(tmpdir(), "bl-shots-"));

/** Starts the server from source on a free port with an empty database, unless E2E_SERVER_URL is set. */
export async function startServer(): Promise<{ url: string; stop: () => void }> {
  if (process.env.E2E_SERVER_URL) return { url: process.env.E2E_SERVER_URL, stop: () => {} };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", ["apps/server/src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "bl-db-")), "e2e.db"),
      // Billing on, so plans and limits show up. Nothing here calls Stripe.
      STRIPE_SECRET_KEY: "sk_test_e2e",
      STRIPE_WEBHOOK_SECRET: "whsec_e2e",
      STRIPE_PRICE_ID: "price_e2e",
      PUBLIC_URL: `http://localhost:${port}`,
      FREE_DEVICES: "10",
    },
    stdio: "inherit",
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/healthz`).then((r) => r.ok, () => false)) return { url, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server didn't start");
}

let failures = 0;
export function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      const at = expected.findIndex((line, i) => JSON.stringify(line) !== JSON.stringify(actual[i]));
      console.log(`  lengths ${expected.length} vs ${actual.length}; first difference at ${at}:`, expected[at], "vs", actual[at]);
    } else {
      console.log("  expected", expected, "\n  actual  ", actual);
    }
    failures++;
  }
}
export const failed = () => failures > 0;

export type Browser = Awaited<ReturnType<typeof launchChromium>>;

/** A fresh Chromium profile with the Chrome build loaded, on its options page. */
export async function launchChromium(name: string) {
  const extension = join(root, "apps/extension/.output/chrome-mv3");
  const context: BrowserContext = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `bl-${name}-`)), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 900, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page: Page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(`chrome-extension://${id}/options.html`);
  const call = (type: string, input?: unknown) =>
    page.evaluate(([type, input]) => chrome.runtime.sendMessage({ type, input }), [type, input] as const);
  const storage = (key: string) => page.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
  /** The bookmark folder titled `title` as indented lines, like the core tests' outline. */
  const bookmarks = (title: string) =>
    page.evaluate(async (title) => {
      const [folder] = await chrome.bookmarks.search({ title });
      if (!folder) return [];
      const render = (n: chrome.bookmarks.BookmarkTreeNode, d: number): string[] => [
        `${"  ".repeat(d)}${n.title}${n.url ? ` ${n.url}` : "/"}`,
        ...(n.children ?? []).flatMap((c) => render(c, d + 1)),
      ];
      const [tree] = await chrome.bookmarks.getSubTree(folder.id);
      return (tree!.children ?? []).flatMap((c) => render(c, 0));
    }, title);
  return { name, context, id, page, call, storage, bookmarks };
}
