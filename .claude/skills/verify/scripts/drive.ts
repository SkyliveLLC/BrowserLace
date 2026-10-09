/**
 * Runs one verification scenario against a throwaway server and isolated Chromium profiles
 * loaded with the built extension (apps/extension/.output/chrome-mv3). Started by verify.sh,
 * which sets VERIFY_OUT; a scenario is a module whose default export takes a `Verify`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check, failed, launchChromium, startServer, type Browser } from "../../../../e2e/harness.ts";

const out = process.env.VERIFY_OUT;
const scenarioPath = process.argv[2];
if (!out || !scenarioPath) throw new Error("Run through verify.sh: .claude/skills/verify/scripts/verify.sh <scenario.ts>");
mkdirSync(out, { recursive: true });
// Always a fresh local server: never let an inherited E2E_SERVER_URL point a run at a real one.
delete process.env.E2E_SERVER_URL;

const server = await startServer();
const browsers: Browser[] = [];

/** Fills the options-page onboarding card titled `heading` and waits for the signed-in view. */
async function onboard(browser: Browser, heading: string, fields: Record<string, string>, submit: string, serverField = server.url) {
  const card = browser.page.locator("form", { has: browser.page.getByRole("heading", { name: heading }) });
  await card.getByLabel("Server", { exact: true }).fill(serverField);
  await card.getByLabel("Name for this browser").fill(browser.name);
  for (const [label, value] of Object.entries(fields)) await card.getByLabel(label, { exact: true }).fill(value);
  await card.getByRole("button", { name: submit }).click();
  await browser.page.getByRole("heading", { name: "Collections" }).waitFor();
}

const verify = {
  server,
  out,
  check,
  /** A fresh Chromium profile with the extension, on its options page. */
  async launch(name: string) {
    const browser = await launchChromium(name);
    browsers.push(browser);
    return browser;
  },
  /** Creates the account from `browser` through the "First browser" form. */
  createAccount: (browser: Browser) => onboard(browser, "First browser", {}, "Create account"),
  /** Joins `to` to `from`'s account with a pairing code shown on `from`'s options page. */
  async pair(from: Browser, to: Browser) {
    await from.page.getByRole("button", { name: "Pair a device" }).click();
    const code = (await from.page.locator(".code").first().textContent())!;
    await from.page.getByRole("button", { name: "Done" }).click();
    await onboard(to, "Add this browser", { "Pairing code or link": code }, "Join");
  },
  /** Saves a full-page screenshot as `<out>/<name>.png`. */
  async shot(page: Browser["page"], name: string) {
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  },
  /** Opens the toolbar popup as a page at the popup's real size. */
  async popup(browser: Browser) {
    const popup = await browser.context.newPage();
    await popup.setViewportSize({ width: 380, height: 580 });
    await popup.goto(`chrome-extension://${browser.id}/popup.html`);
    return popup;
  },
};
export type Verify = typeof verify;

const log = (line: string) => appendFileSync(join(out, "run.log"), `${line}\n`);
const print = console.log;
console.log = (...args: unknown[]) => {
  print(...args);
  log(args.map(String).join(" "));
};

const cleanup = async () => {
  for (const browser of browsers) await browser.context.close().catch(() => {});
  server.stop();
};
process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

let crashed = false;
try {
  const scenario = (await import(pathToFileURL(resolve(scenarioPath)).href)) as { default: (v: Verify) => Promise<void> };
  await scenario.default(verify);
} catch (error) {
  crashed = true;
  console.log(`ERROR ${error instanceof Error ? error.stack : String(error)}`);
  for (const browser of browsers) await browser.page.screenshot({ path: join(out, `crash-${browser.name}.png`) }).catch(() => {});
} finally {
  await cleanup();
}
console.log(`${crashed || failed() ? "FAILED" : "OK"} evidence in ${out}`);
if (crashed || failed()) process.exit(1);
