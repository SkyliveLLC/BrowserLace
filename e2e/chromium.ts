/**
 * Multi-device run in isolated Chromium profiles against a throwaway server.
 * Build first (`pnpm build`), then `pnpm --filter @browserlace/e2e chromium`.
 */
import { check, failed, launchChromium, shots, startServer, type Browser } from "./harness.ts";

const server = await startServer();
const browsers: Browser[] = [];
const launch = async (name: string) => {
  const browser = await launchChromium(name);
  browsers.push(browser);
  return browser;
};

/** Fills the onboarding card titled `heading` and submits it. */
async function onboard(browser: Browser, heading: string, fields: Record<string, string>, submit: string) {
  const card = browser.page.locator("form", { has: browser.page.getByRole("heading", { name: heading }) });
  await card.getByLabel("Server", { exact: true }).fill(server.url);
  await card.getByLabel("Name for this browser").fill(browser.name);
  for (const [label, value] of Object.entries(fields)) await card.getByLabel(label, { exact: true }).fill(value);
  await card.getByRole("button", { name: submit }).click();
  await browser.page.getByRole("heading", { name: "Collections" }).waitFor();
}

async function pairWith(from: Browser, to: Browser) {
  await from.page.getByRole("button", { name: "Pair a device" }).click();
  const code = (await from.page.locator(".code").first().textContent())!;
  await from.page.getByRole("button", { name: "Done" }).click();
  await onboard(to, "Add this browser", { "Pairing code": code.toLowerCase() }, "Join");
}

const epochOf = async (browser: Browser) => ((await browser.storage("config")) as { keyring: { current: number } }).keyring.current;

try {
  const a = await launch("Chromium A");
  const b = await launch("Chromium B");

  // A: create the account and a collection through the real forms, then bookmark natively.
  await onboard(a, "First browser", {}, "Create account");
  await a.page.getByPlaceholder("Work, Research, Recipes…").fill("Work");
  await a.page.getByRole("button", { name: "Create", exact: true }).click();
  await a.page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await a.page.evaluate(async () => {
    const [folder] = await chrome.bookmarks.search({ title: "Work" });
    const docs = await chrome.bookmarks.create({ parentId: folder!.id, title: "Docs" });
    await chrome.bookmarks.create({ parentId: docs.id, title: "MDN", url: "https://developer.mozilla.org/" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "GitHub", url: "https://github.com/" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "Linear", url: "https://linear.app/" });
  });
  await a.call("syncNow");

  // A: create a recovery key before anything else happens to the account.
  await a.page.getByRole("button", { name: "Create recovery key" }).click();
  const recoveryKey = (await a.page.locator(".notice .code").textContent())!;
  await a.page.getByRole("button", { name: "I've saved it" }).click();
  check("recovery key has the expected shape", /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(recoveryKey), true);

  // B joins with a pairing code and syncs "Work" into a new folder.
  await pairWith(a, b);
  await b.page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await b.page.getByRole("button", { name: "Sync to a folder" }).click();
  await b.page.getByRole("button", { name: "Sync this folder" }).click();
  await b.page.getByText(/Syncs to/).waitFor();
  check("B receives A's bookmarks", await b.bookmarks("Work"), await a.bookmarks("Work"));

  // Concurrent edits: A reorders, B renames and adds into a subfolder.
  await a.page.evaluate(async () => {
    const [linear] = await chrome.bookmarks.search({ title: "Linear" });
    await chrome.bookmarks.move(linear!.id, { parentId: linear!.parentId!, index: 0 });
  });
  await b.page.evaluate(async () => {
    const [gh] = await chrome.bookmarks.search({ title: "GitHub" });
    await chrome.bookmarks.update(gh!.id, { title: "GitHub (renamed on B)" });
    const [docs] = await chrome.bookmarks.search({ title: "Docs" });
    await chrome.bookmarks.create({ parentId: docs!.id, title: "TS Handbook", url: "https://www.typescriptlang.org/docs/" });
  });
  for (const browser of [a, b, a]) await browser.call("syncNow");
  const converged = [
    "Linear https://linear.app/",
    "Docs/",
    "  MDN https://developer.mozilla.org/",
    "  TS Handbook https://www.typescriptlang.org/docs/",
    "GitHub (renamed on B) https://github.com/",
  ];
  check("A converges after concurrent edits", await a.bookmarks("Work"), converged);
  check("B converges after concurrent edits", await b.bookmarks("Work"), converged);

  // Mass-delete guard: A deletes a big folder, then puts it back.
  await b.page.evaluate(async () => {
    const [docs] = await chrome.bookmarks.search({ title: "Docs" });
    for (let i = 0; i < 12; i++) await chrome.bookmarks.create({ parentId: docs!.id, title: `extra ${i}`, url: `https://extra${i}.example/` });
  });
  await b.call("syncNow");
  await a.call("syncNow");
  await a.page.evaluate(async () => {
    const [docs] = await chrome.bookmarks.search({ title: "Docs" });
    await chrome.bookmarks.removeTree(docs!.id);
  });
  await a.call("syncNow");
  await a.page.reload();
  await a.page.getByText(/You deleted \d+ bookmarks/).waitFor();
  await a.page.getByRole("button", { name: "Put them back" }).click();
  await a.page.getByText(/You deleted/).waitFor({ state: "detached" });
  check("A gets the deleted folder back", (await a.bookmarks("Work")).length, 17);

  // Tabs: B opens a page; A sees it in the popup.
  const tab = await b.context.newPage();
  await tab.goto(`${server.url}/healthz`);
  await b.call("syncNow");
  const popup = await a.context.newPage();
  await popup.setViewportSize({ width: 380, height: 560 });
  await popup.goto(`chrome-extension://${a.id}/popup.html`);
  await popup.getByText("Chromium B").waitFor();
  await popup.getByText("localhost").first().waitFor();
  await popup.screenshot({ path: `${shots}/popup-tabs.png` });
  await popup.close();

  // History renders restore points.
  await a.page.getByRole("button", { name: "History" }).click();
  await a.page.getByRole("button", { name: "Restore to before" }).first().waitFor();

  // Removing a device moves the account to a new key the removed device never gets.
  const c = await launch("Chromium C");
  await pairWith(a, c);
  await a.page.reload();
  const row = a.page.locator("li", { hasText: "Chromium C" });
  a.page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Remove" }).click();
  await row.waitFor({ state: "detached" });
  check("A starts epoch 2 after removing C", await epochOf(a), 2);
  await b.call("syncNow");
  check("B picks up epoch 2", await epochOf(b), 2);
  check("removed C stays on epoch 1", await epochOf(c), 1);

  await a.page.evaluate(async () => {
    const [folder] = await chrome.bookmarks.search({ title: "Work" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "After rotation", url: "https://after.example/" });
  });
  await a.call("syncNow");
  await b.call("syncNow");
  check("B reads changes sealed with the new key", (await b.bookmarks("Work")).at(-1), "After rotation https://after.example/");

  // Recovery: a brand-new browser gets back in with only the recovery key.
  const d = await launch("Chromium D");
  await d.page.getByRole("button", { name: "Use a recovery key" }).click();
  await onboard(d, "Recover with a recovery key", { "Recovery key": recoveryKey.toLowerCase() }, "Recover");
  await d.page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await d.page.getByRole("button", { name: "Sync to a folder" }).click();
  await d.page.getByRole("button", { name: "Sync this folder" }).click();
  await d.page.getByText(/Syncs to/).waitFor();
  check("D recovers every bookmark, including post-rotation ones", await d.bookmarks("Work"), await a.bookmarks("Work"));
  await d.page.screenshot({ path: `${shots}/options-recovered.png`, fullPage: true });

  console.log(`screenshots in ${shots}`);
} finally {
  for (const browser of browsers) await browser.context.close();
  server.stop();
}
if (failed()) process.exit(1);
