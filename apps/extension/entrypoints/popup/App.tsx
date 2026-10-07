import { buildTree, walk } from "@browserlace/core";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { Alerts } from "../../components/Alerts.tsx";
import { CollectionTree } from "../../components/CollectionTree.tsx";
import { ErrorText, hostname, Logo, timeAgo, useAction, useStored } from "../../components/ui.tsx";
import type { Handlers } from "../../lib/engine.ts";
import { call } from "../../lib/messages.ts";
import {
  collectionsItem,
  collectionStateItem,
  configItem,
  statusItem,
  tabsChangedItem,
  type CollectionSummary,
} from "../../lib/storage.ts";

const openSettings = () => {
  void browser.runtime.openOptionsPage();
  window.close();
};

export function App() {
  const config = useStored(configItem);
  const [view, setView] = useState<"tabs" | "bookmarks">("tabs");
  if (config === undefined) return null;

  return (
    <main className="stack" style={{ width: 380, padding: 12, maxHeight: 580 }}>
      <Header />
      {config === null ? (
        <div className="stack" style={{ padding: "8px 0" }}>
          <p>Sync bookmarks and tabs across your browsers, end-to-end encrypted.</p>
          <button className="primary" onClick={openSettings}>
            Set up BrowserLace
          </button>
        </div>
      ) : (
        <>
          <Alerts onOpenSettings={openSettings} />
          <div className="segmented" role="group">
            <button aria-pressed={view === "tabs"} onClick={() => setView("tabs")}>
              Other devices
            </button>
            <button aria-pressed={view === "bookmarks"} onClick={() => setView("bookmarks")}>
              Collections
            </button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 120 }}>{view === "tabs" ? <DevicesTabs /> : <Collections />}</div>
        </>
      )}
    </main>
  );
}

function Header() {
  const status = useStored(statusItem);
  const config = useStored(configItem);
  const sync = useAction(() => call("syncNow"));
  const label = status?.syncing
    ? "Syncing…"
    : status?.lastSyncAt
      ? `Synced ${timeAgo(status.lastSyncAt)}`
      : config
        ? "Not synced yet"
        : "";
  return (
    <header className="row">
      <Logo />
      <div className="stack" style={{ gap: 0 }}>
        <h1>BrowserLace</h1>
        <span className="muted" style={{ fontSize: 11 }}>
          {label}
        </span>
      </div>
      <span className="spacer" />
      {config && (
        <button className="ghost icon" title="Sync now" aria-label="Sync now" disabled={sync.pending || status?.syncing} onClick={() => sync.run()}>
          ⟳
        </button>
      )}
      <button className="ghost icon" title="Settings" aria-label="Settings" onClick={openSettings}>
        ⚙
      </button>
    </header>
  );
}

type DeviceTabs = Awaited<ReturnType<Handlers["devicesWithTabs"]>>[number];

function DevicesTabs() {
  const [devices, setDevices] = useState<DeviceTabs[]>();
  const [error, setError] = useState<string>();
  // Reloads when another device's tabs change while the popup is open.
  const tabsChanged = useStored(tabsChangedItem);
  useEffect(() => {
    call("devicesWithTabs").then(setDevices, (e: Error) => setError(e.message));
  }, [tabsChanged]);

  if (error) return <ErrorText error={error} />;
  if (!devices) return <p className="muted">Loading…</p>;
  const others = devices.filter((d) => !d.isThisDevice);
  if (others.length === 0) {
    return (
      <p className="muted">
        No other devices yet. Pair one from <button className="link" onClick={openSettings}>settings</button>.
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      {others.map((device) => (
        <section key={device.id} className="stack" style={{ gap: 4 }}>
          <div className="row">
            <h3>{device.name}</h3>
            <span className="muted" style={{ fontSize: 11 }}>
              seen {timeAgo(device.lastSeenAt)}
            </span>
            <span className="spacer" />
            <SendTab deviceId={device.id} />
          </div>
          {!device.snapshot || device.snapshot.windows.length === 0 ? (
            <p className="muted">No shared tabs.</p>
          ) : (
            device.snapshot.windows.map((win, i) => (
              <div key={i} className="stack" style={{ gap: 0 }}>
                <div className="row muted" style={{ fontSize: 11, padding: "0 6px" }}>
                  <span>
                    Window {i + 1} · {win.tabs.length} tabs
                  </span>
                  <span className="spacer" />
                  <button className="link" onClick={() => win.tabs.forEach((t) => void browser.tabs.create({ url: t.url, active: false }))}>
                    Open all
                  </button>
                </div>
                <ul className="list">
                  {win.tabs.map((tab, j) => (
                    <li key={j}>
                      <button className="item" title={tab.url} onClick={() => void browser.tabs.create({ url: tab.url })}>
                        <span className="title">{tab.title}</span>
                        <span className="host">{hostname(tab.url)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}

/** Sends the active tab of this window to a device. */
function SendTab({ deviceId }: { deviceId: string }) {
  const [sent, setSent] = useState(false);
  const send = useAction(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error("This tab can't be sent");
    await call("sendTab", { toDeviceId: deviceId, url: tab.url, title: tab.title ?? tab.url });
    setSent(true);
  });
  return (
    <button className="ghost" style={{ fontSize: 11 }} disabled={send.pending || sent} title={send.error} onClick={() => send.run()}>
      {sent ? "Sent ✓" : send.error ? "Couldn't send" : "Send this tab"}
    </button>
  );
}

function Collections() {
  const collections = useStored(collectionsItem);
  const [query, setQuery] = useState("");
  if (!collections) return null;
  if (collections.length === 0) {
    return (
      <p className="muted">
        No collections yet. Create one in <button className="link" onClick={openSettings}>settings</button>.
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input type="search" placeholder="Search bookmarks" aria-label="Search bookmarks" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {query.trim() ? (
        <SearchResults collections={collections} query={query.trim().toLowerCase()} />
      ) : (
        <ul className="list">
          {collections.map((c) => (
            <CollectionTree key={c.id} collectionId={c.id} name={c.name} />
          ))}
        </ul>
      )}
    </div>
  );
}

type Match = { id: string; title: string; url: string; collection: string };

/** Bookmarks in any collection whose title or URL contains `query`. */
function SearchResults({ collections, query }: { collections: CollectionSummary[]; query: string }) {
  const [matches, setMatches] = useState<Match[]>();
  useEffect(() => {
    let current = true;
    void Promise.all(
      collections.map(async (c) => {
        const tree = buildTree(new Map(Object.entries((await collectionStateItem(c.id).getValue()).nodes)));
        return [...walk(tree)].flatMap(({ node }): Match[] =>
          node.url !== null && `${node.title} ${node.url}`.toLowerCase().includes(query)
            ? [{ id: node.id, title: node.title || node.url, url: node.url, collection: c.name }]
            : [],
        );
      }),
    ).then((results) => current && setMatches(results.flat().slice(0, 100)));
    return () => void (current = false);
  }, [collections, query]);

  if (!matches) return null;
  if (matches.length === 0) return <p className="muted">No bookmarks match.</p>;
  return (
    <ul className="list">
      {matches.map((m) => (
        <li key={`${m.collection}:${m.id}`}>
          <button className="item" title={m.url} onClick={() => void browser.tabs.create({ url: m.url })}>
            <span className="title">{m.title}</span>
            <span className="host">{m.collection}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
