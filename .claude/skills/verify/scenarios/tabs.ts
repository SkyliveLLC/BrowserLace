/**
 * Proof for features/tabs.md: A sees B's open tabs in the popup, and A sends its active tab
 * to B with the popup's "Send this tab" button, which B opens.
 */
import type { Verify } from "../scripts/drive.ts";

export default async function ({ launch, createAccount, pair, check, shot, popup, server }: Verify) {
  const a = await launch("Chromium A");
  const b = await launch("Chromium B");
  await createAccount(a);
  await pair(a, b);

  // B opens a page; only http(s) tabs are shared.
  const onB = await b.context.newPage();
  await onB.goto(`${server.url}/healthz?on=b`);
  await b.call("syncNow");

  const pop = await popup(a);
  await pop.getByRole("heading", { name: "Chromium B" }).waitFor();
  await pop.locator(".item", { hasText: "localhost" }).first().waitFor();
  check("A's popup lists B's tab", await pop.locator(".item").first().getAttribute("title"), `${server.url}/healthz?on=b`);
  await shot(pop, "1-a-popup-other-devices");

  // "Send this tab" sends the active tab of the popup's window, so make the page to send active first.
  const toSend = await a.context.newPage();
  const sentUrl = `${server.url}/healthz?sent=1`;
  await toSend.goto(sentUrl);
  await toSend.bringToFront();
  const opened = b.context.waitForEvent("page", { predicate: (p) => p.url() === sentUrl, timeout: 15_000 });
  await pop.locator("section", { has: pop.getByRole("heading", { name: "Chromium B" }) }).getByRole("button", { name: "Send this tab" }).click();
  await pop.getByRole("button", { name: "Sent ✓" }).waitFor();
  await opened;
  check("B opens the sent tab", b.context.pages().some((p) => p.url() === sentUrl), true);
  await shot(pop, "2-a-popup-sent");
}
