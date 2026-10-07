import type { TabsSnapshot } from "@browserlace/core";
import { browser } from "wxt/browser";

/** This browser's open, non-private web tabs, grouped by window. */
export async function captureTabs(): Promise<TabsSnapshot> {
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return {
    v: 1,
    capturedAt: Date.now(),
    windows: windows
      .filter((w) => !w.incognito)
      .map((w) => ({
        focused: w.focused,
        tabs: (w.tabs ?? [])
          .filter((t) => t.url && /^https?:/.test(t.url))
          .map((t) => ({ title: t.title || t.url!, url: t.url!, pinned: t.pinned, active: t.active })),
      }))
      .filter((w) => w.tabs.length > 0),
  };
}
