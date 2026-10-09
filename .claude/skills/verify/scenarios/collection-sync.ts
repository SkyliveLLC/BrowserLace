/**
 * Proof for features/collection-sync.md: A creates "Work" and bookmarks into it, B pairs,
 * syncs "Work" into a new folder, edits it, and A receives the edit live.
 * Copy this file as the starting point for other scenarios.
 */
import type { Verify } from "../scripts/drive.ts";

export default async function ({ launch, createAccount, pair, check, shot }: Verify) {
  const a = await launch("Chromium A");
  const b = await launch("Chromium B");

  // A: account and collection through the real forms.
  await createAccount(a);
  await a.page.getByPlaceholder("Work, Research, Recipes…").fill("Work");
  await a.page.getByRole("button", { name: "Create", exact: true }).click();
  await a.page.getByRole("heading", { name: "Work", exact: true }).waitFor();

  // Native bookmark edits fire the same events as a user editing in the bookmarks manager.
  await a.page.evaluate(async () => {
    const [folder] = await chrome.bookmarks.search({ title: "Work" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "GitHub", url: "https://github.com/" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "Linear", url: "https://linear.app/" });
  });
  await a.call("syncNow");
  await shot(a.page, "1-a-collection-created");

  // B pairs and syncs "Work" into a new folder, two-way.
  await pair(a, b);
  const card = b.page.locator(".card", { has: b.page.getByRole("heading", { name: "Work", exact: true }) });
  await card.getByRole("button", { name: "Sync to a folder" }).click();
  await card.getByRole("button", { name: "Sync this folder" }).click();
  await card.getByText(/Syncs to/).waitFor();
  console.log(`  B right after "Syncs to" appears: ${JSON.stringify(await b.bookmarks("Work"))}`);
  await b.call("syncNow");
  check("B receives A's bookmarks", await b.bookmarks("Work"), ["GitHub https://github.com/", "Linear https://linear.app/"]);
  await shot(b.page, "2-b-mounted");

  // B edits; A gets it without a manual sync (live push + 2s edit debounce).
  await b.page.evaluate(async () => {
    const [folder] = await chrome.bookmarks.search({ title: "Work" });
    await chrome.bookmarks.create({ parentId: folder!.id, title: "From B", url: "https://from-b.example/" });
  });
  const start = Date.now();
  while (!(await a.bookmarks("Work")).includes("From B https://from-b.example/") && Date.now() - start < 15_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  B's edit reached A in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  check("A receives B's edit live", (await a.bookmarks("Work")).at(-1), "From B https://from-b.example/");
  await shot(a.page, "3-a-received-edit");
}
