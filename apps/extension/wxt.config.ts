import { defineConfig } from "wxt";

/** Must stay the same once published on addons.mozilla.org. */
const firefoxAddonId = process.env.WXT_FIREFOX_ADDON_ID || "browserlace@browserlace.app";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "BrowserLace",
    description: "End-to-end encrypted bookmark and tab sync across Chrome, Firefox and Safari.",
    // Safari has no WebExtension bookmarks or notifications API; it browses collections inside the extension.
    permissions: [
      "storage",
      "unlimitedStorage",
      "alarms",
      "tabs",
      "contextMenus",
      ...(browser === "safari" ? [] : ["bookmarks", "notifications"]),
    ],
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: firefoxAddonId,
          // 140+ shows Firefox's built-in data consent prompt for the permissions below.
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["bookmarksInfo", "browsingActivity"] },
        },
        gecko_android: { strict_min_version: "142.0" },
      },
    }),
  }),
});
