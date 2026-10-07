import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { hasBookmarksApi } from "../lib/bookmarks.ts";
import { handlers, schedulePublishTabs, scheduleSync } from "../lib/engine.ts";
import type { Reply, Request } from "../lib/messages.ts";

const SYNC_ALARM = "sync";

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { type, input } = message as Request;
    const handler = handlers[type] as (input: unknown) => Promise<unknown>;
    handler(input).then(
      (value): void => sendResponse({ ok: true, value } satisfies Reply),
      (error: unknown): void =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Reply),
    );
    return true;
  });

  // Recreating an existing alarm would push its next run back on every worker restart.
  void browser.alarms.get(SYNC_ALARM).then((alarm) => {
    if (!alarm) void browser.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) scheduleSync();
  });
  browser.runtime.onStartup.addListener(() => scheduleSync());
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === "install") void browser.runtime.openOptionsPage();
    scheduleSync();
  });

  if (hasBookmarksApi()) {
    const { onCreated, onChanged, onMoved, onRemoved, onChildrenReordered } = browser.bookmarks;
    for (const event of [onCreated, onChanged, onMoved, onRemoved, onChildrenReordered]) {
      event?.addListener(() => scheduleSync(2000));
    }
  }

  browser.tabs.onCreated.addListener(() => schedulePublishTabs());
  browser.tabs.onRemoved.addListener(() => schedulePublishTabs());
  browser.tabs.onUpdated.addListener((_id, change) => {
    if (change.url || change.title) schedulePublishTabs();
  });
});
