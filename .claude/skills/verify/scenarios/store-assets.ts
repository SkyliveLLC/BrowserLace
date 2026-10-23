/**
 * Chrome Web Store assets from demo data: five 1280×800 screenshots and the 440×280 small
 * promo tile, written to the run's out-dir. Copy them to docs/store/ (see docs/store-listing.md).
 * "Work laptop" and "Home desktop" share one account; Home's tabs are local stub pages.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "../../../../e2e/harness.ts";
import type { Verify } from "../scripts/drive.ts";

const icon = readFileSync(join(import.meta.dirname, "../../../../apps/extension/public/icon/128.png"));
const hostedServer = "https://browserlace.skylive.world";

const homeTabs = [
  ["https://en.wikipedia.org/wiki/Bookmark_(digital)", "Bookmark (digital) - Wikipedia"],
  ["https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API", "Web Crypto API - Web APIs | MDN"],
  ["https://www.openstreetmap.org/#map=13/45.4642/9.1900", "OpenStreetMap"],
  ["https://news.ycombinator.com/", "Hacker News"],
  ["https://www.rfc-editor.org/rfc/rfc9110", "RFC 9110: HTTP Semantics"],
  ["https://github.com/SkyliveLLC/BrowserLace", "SkyliveLLC/BrowserLace: Keep the browsers you like"],
];

const frames = [
  ["collections", "Choose what follows you", "Sync the bookmark folders you pick, the way you pick: two-way, receive only or send only."],
  ["popup-tabs", "Pick up where you left off", "See the tabs open on your other browsers, and send a tab over in one click."],
  ["pair", "Add a browser in seconds", "Scan the code or type it in. Everything is end-to-end encrypted, so the server never sees your bookmarks."],
  ["history", "Undo anything", "Every collection keeps a history you can restore from, and big deletions wait for your OK."],
  ["popup-search", "Find any bookmark", "Search every collection from the toolbar, even the ones this browser doesn't sync."],
] as const;

const css = `
  * { margin: 0; box-sizing: border-box; }
  body { font-family: "Nimbus Sans", Helvetica, Arial, sans-serif; color: #fff; overflow: hidden;
         background: radial-gradient(circle at 15% 20%, #6d64f7, #4f46e5 45%, #3730a3); }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 700; }
  h1 { font-size: 50px; line-height: 56px; letter-spacing: -0.02em; }
  p { font-size: 21px; line-height: 31px; color: #e0e1ff; }
  .shot { border-radius: 14px; box-shadow: 0 30px 70px rgba(20, 16, 80, 0.45); background: #fff; display: block; }
`;

export default async function ({ launch, createAccount, check, shot, popup, server, out }: Verify) {
  const work = await launch("Work laptop");
  const home = await launch("Home desktop");
  const raw: Record<string, Buffer> = {};
  const addBookmarks = (b: typeof work, folder: string, items: string[][]) =>
    b.page.evaluate(
      async ([folder, items]) => {
        const [parent] = await chrome.bookmarks.search({ title: folder });
        for (const [title, url] of items) await chrome.bookmarks.create({ parentId: parent!.id, title, url });
      },
      [folder, items] as const,
    );
  const createCollection = async (b: typeof work, name: string, direction?: string) => {
    const form = b.page.locator("form", { hasText: "New collection" });
    // Direction first: changing it re-renders the form and clears the name.
    if (direction) await form.getByLabel("Direction").selectOption(direction);
    await b.page.getByPlaceholder("Work, Research, Recipes…").fill(name);
    const submit = b.page.getByRole("button", { name: "Create", exact: true });
    await submit.click();
    await b.page.getByRole("heading", { name, exact: true }).waitFor();
    // The card appears before the request settles; the form resets (clearing typed text) when it does.
    while (await submit.isDisabled()) await new Promise((r) => setTimeout(r, 50));
  };
  const section = (b: typeof work, heading: string) =>
    b.page.locator("section", { has: b.page.getByRole("heading", { name: heading, exact: true }) });
  await work.page.setViewportSize({ width: 820, height: 900 });

  // Work laptop: a two-way and a send-only collection.
  await createAccount(work);
  await createCollection(work, "Work");
  await addBookmarks(work, "Work", [
    ["Team roadmap", "https://docs.example.com/roadmap"],
    ["Sprint planning board", "https://board.example.com/sprint"],
    ["On-call runbook", "https://wiki.example.com/runbook"],
    ["Expense report", "https://expenses.example.com/new"],
  ]);
  await createCollection(work, "Reading list", "send");
  await addBookmarks(work, "Reading list", [["Local-first software", "https://www.inkandswitch.com/local-first/"]]);
  await work.call("syncNow");

  // Pair Home desktop, capturing the pairing panel as a user of the hosted server sees it.
  await work.page.getByRole("button", { name: "Pair a device" }).click();
  const code = (await work.page.locator(".code").first().textContent())!;
  await section(work, "Devices").locator("strong").evaluate((el, url) => (el.textContent = url), hostedServer);
  raw.pair = await section(work, "Devices").screenshot();
  await work.page.getByRole("button", { name: "Done" }).click();
  const join_ = home.page.locator("form", { has: home.page.getByRole("heading", { name: "Add this browser" }) });
  await join_.getByLabel("Server", { exact: true }).fill(server.url);
  await join_.getByLabel("Name for this browser").fill(home.name);
  await join_.getByLabel("Pairing code or link", { exact: true }).fill(code);
  await join_.getByRole("button", { name: "Join" }).click();
  await home.page.getByRole("heading", { name: "Collections" }).waitFor();

  // Home desktop: personal collections. Work laptop receives "Personal" and leaves "Recipes" alone.
  await createCollection(home, "Personal");
  await addBookmarks(home, "Personal", [
    ["Weekend hikes", "https://trails.example.org/weekend"],
    ["Trip planner", "https://travel.example.com/planner"],
  ]);
  await createCollection(home, "Recipes");
  await addBookmarks(home, "Recipes", [
    ["Weeknight pasta", "https://recipes.example.org/pasta-al-limone"],
    ["Weekly meal plan", "https://recipes.example.org/meal-plan"],
    ["Sourdough starter", "https://recipes.example.org/sourdough-starter"],
  ]);
  await home.call("syncNow");
  await work.call("syncNow");
  const personal = work.page.locator(".card", { has: work.page.getByRole("heading", { name: "Personal", exact: true }) });
  await personal.getByRole("button", { name: "Sync to a folder" }).click();
  await personal.getByLabel("Direction").selectOption("receive");
  await personal.getByRole("button", { name: "Sync this folder" }).click();
  await personal.getByText(/Syncs to/).waitFor();
  await work.call("syncNow");
  check("Work laptop receives Personal", await work.bookmarks("Personal"), [
    "Weekend hikes https://trails.example.org/weekend",
    "Trip planner https://travel.example.com/planner",
  ]);

  // A deletion, so Work's history has more than one entry.
  await work.page.evaluate(async () => {
    const [bookmark] = await chrome.bookmarks.search({ title: "Expense report" });
    await chrome.bookmarks.remove(bookmark!.id);
  });
  await work.call("syncNow");

  raw.collections = await section(work, "Collections").screenshot();
  const workCard = work.page.locator(".card", { has: work.page.getByRole("heading", { name: "Work", exact: true }) });
  await workCard.getByRole("button", { name: "History" }).click();
  await workCard.getByRole("button", { name: "Restore to before" }).first().waitFor();
  raw.history = await workCard.screenshot();

  // Home desktop's open tabs, served locally so the run needs no network.
  await home.context.route(/^https:/, (route) => {
    const title = homeTabs.find(([url]) => route.request().url().startsWith(url!.split("#")[0]!))?.[1] ?? "Page";
    return route.fulfill({ contentType: "text/html", body: `<title>${title}</title>` });
  });
  for (const [url] of homeTabs) await (await home.context.newPage()).goto(url!);
  await home.call("syncNow");

  // The popup loads devices once on open, so reopen it until Home desktop's tabs are published.
  let pop = await popup(work);
  for (let i = 0; i < 20; i++) {
    const listed = pop.locator(".item", { hasText: "SkyliveLLC/BrowserLace" });
    if (await listed.waitFor({ timeout: 1000 }).then(() => true, () => false)) break;
    await pop.close();
    pop = await popup(work);
  }
  check("Work laptop's popup lists Home desktop's tabs", await pop.locator(".item").count(), homeTabs.length);
  raw["popup-tabs"] = await pop.screenshot();
  await pop.getByRole("button", { name: "Collections" }).click();
  await pop.getByPlaceholder("Search bookmarks").fill("plan");
  await pop.locator(".item", { hasText: "Weekly meal plan" }).waitFor();
  check(
    "popup search spans collections, including Recipes, which Work laptop doesn't sync",
    (await pop.locator(".item .title").allTextContents()).sort(),
    ["Sprint planning board", "Trip planner", "Weekly meal plan"],
  );
  raw["popup-search"] = await pop.screenshot();

  // Compose each image at its exact pixel size in its own plain browser, after closing the
  // extension profiles: with them open, or with several screenshots in one browser, this
  // Chromium build's renderer segfaults.
  await work.context.close();
  await home.context.close();
  const compose = async (name: string, width: number, height: number, html: string) => {
    const plain = await chromium.launch({ channel: "chromium", headless: true });
    const canvas = await plain.newPage({ viewport: { width, height } });
    await canvas.setContent(`<style>${css}</style>${html}`);
    await shot(canvas, name);
    await plain.close();
  };
  const png = (buffer: Buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
  for (const [i, [name, title, body]] of frames.entries()) {
    // Popups are shown at their real size; options-page sections get a margin inside the frame.
    const size = name.startsWith("popup") ? "width: 380px" : "max-width: 700px; max-height: 680px; padding: 24px";
    await compose(`screenshot-${i + 1}-${name}`, 1280, 800, `<style>
      main { display: flex; align-items: center; height: 800px; padding: 0 72px; gap: 64px; }
      .copy { flex: 0 0 400px; display: flex; flex-direction: column; gap: 22px; }
      .stage { flex: 1; display: flex; justify-content: center; }</style>
      <main><div class="copy"><div class="brand"><img src="${png(icon)}" width="40">BrowserLace</div>
      <h1>${title}</h1><p>${body}</p></div>
      <div class="stage"><img class="shot" style="${size}" src="${png(raw[name]!)}"></div></main>`);
  }
  await compose("promo-tile-440x280", 440, 280, `<style>
    main { height: 280px; display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 0 36px; }
    .brand { font-size: 34px; gap: 14px; } p { font-size: 18px; line-height: 25px; }</style>
    <main><div class="brand"><img src="${png(icon)}" width="64">BrowserLace</div>
    <p>Sync bookmark folders and tabs across Chrome, Firefox and Safari. End-to-end encrypted.</p></main>`);
  console.log(`  store assets in ${out}`);
}
