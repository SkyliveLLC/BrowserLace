import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { hasBookmarksApi } from "../lib/bookmarks.ts";
import { handlers, onLiveEvent, schedulePublishTabs, scheduleSync } from "../lib/engine.ts";
import { ensureLive } from "../lib/live.ts";
import type { Reply, Request } from "../lib/messages.ts";
import { configItem, devicesItem } from "../lib/storage.ts";

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
    if (alarm.name !== SYNC_ALARM) return;
    scheduleSync();
    void ensureLive(onLiveEvent);
  });
  void ensureLive(onLiveEvent);
  configItem.watch(() => void ensureLive(onLiveEvent));
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

  // "Send to <device>" on pages and links, one item per other device.
  const menus = browser.contextMenus;
  const MENU = "send-to";
  const rebuildMenus = async (devices: { id: string; name: string }[]) => {
    await menus.removeAll();
    if (devices.length === 0) return;
    menus.create({ id: MENU, title: "Send to device", contexts: ["page", "link"] });
    for (const device of devices) menus.create({ id: `${MENU}:${device.id}`, parentId: MENU, title: device.name, contexts: ["page", "link"] });
  };
  void devicesItem.getValue().then(rebuildMenus);
  devicesItem.watch((devices) => void rebuildMenus(devices));
  menus.onClicked.addListener((info, tab) => {
    const toDeviceId = String(info.menuItemId).split(":")[1];
    const url = info.linkUrl ?? tab?.url;
    if (!toDeviceId || !url) return;
    void handlers.sendTab({ toDeviceId, url, title: info.linkUrl ? (info.selectionText ?? url) : (tab?.title ?? url) });
  });

  // A notification for a received tab focuses that tab.
  browser.notifications?.onClicked.addListener((id) => {
    const tabId = Number(id.replace("send:", ""));
    if (!Number.isInteger(tabId)) return;
    void browser.tabs.update(tabId, { active: true }).then(async (tab) => {
      if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    });
  });
});
