import type { MountMode } from "@browserlace/core";
import { useEffect, useState, type FormEvent } from "react";
import { Alerts } from "../../components/Alerts.tsx";
import { Qr } from "../../components/Qr.tsx";
import { ErrorText, Logo, Notice, modeLabel, timeAgo, useAction, useStored } from "../../components/ui.tsx";
import { folderPath, hasBookmarksApi, listFolders, type FolderOption } from "../../lib/bookmarks.ts";
import type { Handlers } from "../../lib/engine.ts";
import { call } from "../../lib/messages.ts";
import { defaultDeviceName } from "../../lib/platform.ts";
import { collectionsItem, configItem, mountsItem, shareTabsItem, type CollectionSummary } from "../../lib/storage.ts";

const DEFAULT_SERVER_URL = import.meta.env.WXT_DEFAULT_SERVER_URL ?? "http://localhost:8787";

export function App() {
  const config = useStored(configItem);
  if (config === undefined) return null;
  return (
    <main className="stack" style={{ maxWidth: 720, margin: "0 auto", padding: "32px 20px", gap: 20 }}>
      <header className="row">
        <Logo size={28} />
        <h1 style={{ fontSize: 20 }}>BrowserLace</h1>
      </header>
      {config === null ? (
        <Onboarding />
      ) : (
        <>
          <Alerts />
          <Collections />
          {hasBookmarksApi() && <Profiles />}
          <Devices />
          <RecoveryKey />
          <ThisBrowser />
        </>
      )}
    </main>
  );
}

/** Calls `fn` with the form's fields once it's submitted. */
const onSubmit = (fn: (fields: Record<string, string>) => void) => (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  fn(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
};

function Onboarding() {
  const create = useAction((f: Record<string, string>) =>
    call("createAccount", { serverUrl: f.serverUrl!, deviceName: f.deviceName!, signupToken: f.signupToken || undefined }),
  );
  const join = useAction((f: Record<string, string>) =>
    call("joinAccount", { serverUrl: f.serverUrl!, deviceName: f.deviceName!, code: f.code! }),
  );
  const recover = useAction((f: Record<string, string>) =>
    call("recoverAccount", { serverUrl: f.serverUrl!, deviceName: f.deviceName!, recoveryKey: f.recoveryKey! }),
  );
  const [recovering, setRecovering] = useState(false);
  const fields = (
    <>
      <label>
        Server
        <input name="serverUrl" type="url" required defaultValue={DEFAULT_SERVER_URL} />
      </label>
      <label>
        Name for this browser
        <input name="deviceName" required defaultValue={defaultDeviceName()} />
      </label>
    </>
  );
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted">
        Sync bookmark folders and open tabs across Chrome, Firefox and Safari. Everything is encrypted on your devices
        before it reaches the server.
      </p>
      <div className="row" style={{ alignItems: "stretch", gap: 16, flexWrap: "wrap" }}>
        <form className="card stack" style={{ flex: 1, minWidth: 280 }} onSubmit={onSubmit(create.run)}>
          <h2>First browser</h2>
          <p className="muted">Create a new account and encryption key.</p>
          {fields}
          <label>
            Signup token <span className="muted">(only if your server requires one)</span>
            <input name="signupToken" />
          </label>
          <button className="primary" disabled={create.pending}>
            {create.pending ? "Creating…" : "Create account"}
          </button>
          <ErrorText error={create.error} />
        </form>
        <form className="card stack" style={{ flex: 1, minWidth: 280 }} onSubmit={onSubmit(join.run)}>
          <h2>Add this browser</h2>
          <p className="muted">On a browser that's already set up, open settings → Devices → Pair a device.</p>
          {fields}
          <label>
            Pairing code or link
            <input name="code" required placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} />
          </label>
          <button className="primary" disabled={join.pending}>
            {join.pending ? "Joining…" : "Join"}
          </button>
          <ErrorText error={join.error} />
        </form>
      </div>
      {recovering ? (
        <form className="card stack" onSubmit={onSubmit(recover.run)}>
          <h2>Recover with a recovery key</h2>
          <p className="muted">Use this if none of your other browsers are available to pair with.</p>
          {fields}
          <label>
            Recovery key
            <textarea name="recoveryKey" required rows={2} autoComplete="off" spellCheck={false} className="code" />
          </label>
          <div className="row">
            <button className="primary" disabled={recover.pending}>
              {recover.pending ? "Recovering…" : "Recover"}
            </button>
            <ErrorText error={recover.error} />
          </div>
        </form>
      ) : (
        <p className="muted">
          Lost access to your other browsers?{" "}
          <button className="link" onClick={() => setRecovering(true)}>
            Use a recovery key
          </button>
        </p>
      )}
    </div>
  );
}

function useFolders() {
  const [folders, setFolders] = useState<FolderOption[]>([]);
  useEffect(() => {
    if (hasBookmarksApi()) void listFolders().then(setFolders);
  }, []);
  return folders;
}

/** Folder and mode pickers shared by "new collection" and "sync to folder". */
function MountFields({ newFolderLabel }: { newFolderLabel: string }) {
  const folders = useFolders();
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <label style={{ flex: 2, minWidth: 220 }}>
        Folder in this browser
        <select name="folder" defaultValue="new">
          <option value="new">{newFolderLabel}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </select>
      </label>
      <label style={{ flex: 1, minWidth: 160 }}>
        Direction
        <select name="mode" defaultValue="two-way">
          <option value="two-way">Two-way</option>
          <option value="receive">Receive only</option>
          <option value="send">Send only</option>
        </select>
      </label>
    </div>
  );
}

function Collections() {
  const collections = useStored(collectionsItem) ?? [];
  const create = useAction(async (f: Record<string, string>, form: HTMLFormElement) => {
    await call("createCollection", {
      name: f.name!,
      folder: hasBookmarksApi() ? f.folder! : null,
      mode: (f.mode ?? "two-way") as MountMode,
    });
    form.reset();
  });
  return (
    <section className="stack">
      <h2>Collections</h2>
      <p className="muted">
        A collection is a set of bookmarks you choose to sync. Each browser decides which collections it syncs and into
        which folder.
        {!hasBookmarksApi() && " Safari doesn't let extensions edit its bookmarks, so collections open from the toolbar popup here."}
      </p>
      {collections.map((c) => (
        <CollectionCard key={c.id} collection={c} />
      ))}
      <form
        className="card stack"
        onSubmit={(event) => {
          const form = event.currentTarget;
          onSubmit((f) => create.run(f, form))(event);
        }}
      >
        <h3>New collection</h3>
        <label>
          Name
          <input name="name" required placeholder="Work, Research, Recipes…" />
        </label>
        {hasBookmarksApi() && <MountFields newFolderLabel="New folder in Other Bookmarks" />}
        <div className="row">
          <button className="primary" disabled={create.pending}>
            Create
          </button>
          <ErrorText error={create.error} />
        </div>
      </form>
    </section>
  );
}

function CollectionCard({ collection }: { collection: CollectionSummary }) {
  const mount = useStored(mountsItem)?.[collection.id];
  const [path, setPath] = useState<string>();
  const [panel, setPanel] = useState<"mount" | "history" | null>(null);
  const action = useAction((run: () => Promise<unknown>) => run());
  useEffect(() => {
    if (mount) void folderPath(mount.folderId).then(setPath);
  }, [mount?.folderId]);

  const mountAction = useAction(async (f: Record<string, string>) => {
    await call("mount", { collectionId: collection.id, folder: f.folder!, mode: f.mode as MountMode });
    setPanel(null);
  });

  return (
    <div className="card stack">
      <div className="row">
        <h3>{collection.name}</h3>
        {mount && <span className="tag">{modeLabel[mount.mode]}</span>}
        <span className="spacer" />
        <button
          className="ghost"
          onClick={() => {
            const name = prompt("Rename collection", collection.name)?.trim();
            if (name) void action.run(() => call("renameCollection", { collectionId: collection.id, name }));
          }}
        >
          Rename
        </button>
        <button className="ghost" onClick={() => setPanel(panel === "history" ? null : "history")}>
          History
        </button>
        <button
          className="ghost danger"
          onClick={() => {
            if (confirm(`Delete “${collection.name}” for every device? Bookmarks already in your browsers stay.`)) {
              void action.run(() => call("deleteCollection", { collectionId: collection.id }));
            }
          }}
        >
          Delete
        </button>
      </div>
      {hasBookmarksApi() && (
        <div className="row">
          <p className="muted">
            {mount
              ? mount.paused?.reason === "folder-missing"
                ? "Its folder in this browser was deleted."
                : `Syncs to ${path ?? "…"}`
              : "Not synced in this browser."}
          </p>
          <span className="spacer" />
          <button onClick={() => setPanel(panel === "mount" ? null : "mount")}>
            {mount ? "Change folder" : "Sync to a folder"}
          </button>
          {mount && (
            <button onClick={() => void action.run(() => call("unmount", { collectionId: collection.id }))}>Stop syncing here</button>
          )}
        </div>
      )}
      {panel === "mount" && (
        <form className="stack" onSubmit={onSubmit(mountAction.run)}>
          <MountFields newFolderLabel={`New folder “${collection.name}” in Other Bookmarks`} />
          <p className="muted">
            Two-way merges a folder's existing bookmarks into the collection. Receive only needs a new or empty folder.
            Send only makes the collection match this folder, undoing edits made elsewhere.
          </p>
          <div className="row">
            <button className="primary" disabled={mountAction.pending}>
              Sync this folder
            </button>
            <ErrorText error={mountAction.error} />
          </div>
        </form>
      )}
      {panel === "history" && <History collectionId={collection.id} />}
      <ErrorText error={action.error} />
    </div>
  );
}

type HistoryEntry = Awaited<ReturnType<Handlers["history"]>>[number];

function History({ collectionId }: { collectionId: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const load = useAction(async () => setEntries(await call("history", { collectionId })));
  const restore = useAction(async (beforeSeq: number) => {
    await call("restore", { collectionId, beforeSeq });
    await load.run();
  });
  useEffect(() => void load.run(), [collectionId]);

  if (!entries) return <p className="muted">{load.error ?? "Loading history…"}</p>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="muted">Restoring undoes a change and everything after it, on every device. It can be undone too.</p>
      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.seq} className="row item">
            <span className="title">
              {entry.device} · {entry.ops} change{entry.ops === 1 ? "" : "s"}
              {entry.deletes > 0 && `, ${entry.deletes} deleted`}
            </span>
            <span className="muted">{timeAgo(entry.createdAt)}</span>
            <span className="spacer" />
            <button
              disabled={restore.pending}
              onClick={() => {
                if (confirm("Restore this collection to how it was before this change?")) void restore.run(entry.seq);
              }}
            >
              Restore to before
            </button>
          </li>
        ))}
      </ul>
      <ErrorText error={restore.error} />
    </div>
  );
}

type Device = Awaited<ReturnType<Handlers["devicesWithTabs"]>>[number];

function Devices() {
  const [devices, setDevices] = useState<Device[]>();
  const [pairing, setPairing] = useState<Awaited<ReturnType<Handlers["createPairingCode"]>>>();
  const load = useAction(async () => setDevices(await call("devicesWithTabs")));
  const pair = useAction(async () => setPairing(await call("createPairingCode")));
  const remove = useAction(async (device: Device) => {
    if (!confirm(`Remove “${device.name}”? It stops syncing immediately.`)) return;
    await call("removeDevice", { deviceId: device.id });
    await load.run();
  });
  useEffect(() => void load.run(), []);

  return (
    <section className="stack">
      <h2>Devices</h2>
      <div className="card stack">
        <ul className="list">
          {devices?.map((device) => (
            <li key={device.id} className="row item">
              <span className="title">{device.name}</span>
              {device.isThisDevice && <span className="tag">This browser</span>}
              <span className="spacer" />
              <span className="muted">{device.isThisDevice ? "" : `seen ${timeAgo(device.lastSeenAt)}`}</span>
              {!device.isThisDevice && (
                <button className="ghost danger" disabled={remove.pending} onClick={() => remove.run(device)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <ErrorText error={load.error ?? remove.error} />
        {pairing ? (
          <PairingCode pairing={pairing} onDone={() => {
            setPairing(undefined);
            void load.run();
          }} />
        ) : (
          <div className="row">
            <button className="primary" disabled={pair.pending} onClick={() => pair.run()}>
              Pair a device
            </button>
            <ErrorText error={pair.error} />
          </div>
        )}
      </div>
    </section>
  );
}

type Pairing = Awaited<ReturnType<Handlers["createPairingCode"]>>;

function PairingCode({ pairing, onDone }: { pairing: Pairing; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((pairing.expiresAt - now) / 1000));
  return (
    <Notice>
      <div className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <Qr text={pairing.link} />
        <div className="stack" style={{ flex: 1, minWidth: 240 }}>
          <p>
            On the new browser, install BrowserLace, choose “Add this browser” and paste the pairing link, or scan the
            code with your phone. Or enter the server <strong>{pairing.serverUrl}</strong> and this code:
          </p>
          <span className="code">{pairing.code}</span>
          <div className="row">
            <button className="ghost" onClick={() => void navigator.clipboard.writeText(pairing.link)}>
              Copy link
            </button>
            <button className="ghost" onClick={() => void navigator.clipboard.writeText(pairing.code)}>
              Copy code
            </button>
          </div>
        </div>
      </div>
      <div className="row">
        <span className="muted">
          {left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}. Works once.` : "Expired."}
        </span>
        <span className="spacer" />
        <button onClick={onDone}>Done</button>
      </div>
    </Notice>
  );
}

type Profile = Awaited<ReturnType<Handlers["profiles"]>>[number];

/** Saved sets of mounts, so a new browser can sync the right collections in one step. */
function Profiles() {
  const [profiles, setProfiles] = useState<Profile[]>();
  const mounts = useStored(mountsItem) ?? {};
  const collections = useStored(collectionsItem) ?? [];
  const load = useAction(async () => setProfiles(await call("profiles")));
  const save = useAction(async (f: Record<string, string>, form: HTMLFormElement) => {
    await call("saveProfile", { name: f.name! });
    form.reset();
    await load.run();
  });
  const action = useAction(async (run: () => Promise<unknown>) => {
    await run();
    await load.run();
  });
  useEffect(() => void load.run(), []);
  const name = (id: string) => collections.find((c) => c.id === id)?.name ?? "Deleted collection";

  return (
    <section className="stack">
      <h2>Profiles</h2>
      <p className="muted">
        A profile remembers which collections a browser syncs and how, like “Work laptop”. Apply it on a new browser to
        set it up in one step.
      </p>
      {profiles?.map((profile) => {
        const pending = profile.rules.filter((r) => !mounts[r.collectionId] && collections.some((c) => c.id === r.collectionId));
        return (
          <div key={profile.id} className="card stack">
            <div className="row">
              <h3>{profile.name}</h3>
              <span className="spacer" />
              <button className="primary" disabled={action.pending || pending.length === 0} onClick={() => action.run(() => call("applyProfile", { profileId: profile.id }))}>
                {pending.length === 0 ? "Applied" : "Apply here"}
              </button>
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`Delete the profile “${profile.name}”? Nothing already synced changes.`)) {
                    void action.run(() => call("deleteProfile", { profileId: profile.id }));
                  }
                }}
              >
                Delete
              </button>
            </div>
            <ul className="list">
              {profile.rules.map((rule) => (
                <li key={rule.collectionId} className="row item">
                  <span className="title">{name(rule.collectionId)}</span>
                  <span className="tag">{modeLabel[rule.mode]}</span>
                  <span className="muted">into “{rule.folderTitle}”</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <form
        className="card row"
        onSubmit={(event) => {
          const form = event.currentTarget;
          onSubmit((f) => save.run(f, form))(event);
        }}
      >
        <input name="name" required placeholder="Work laptop, Home…" aria-label="Profile name" style={{ flex: 1 }} />
        <button disabled={save.pending || Object.keys(mounts).length === 0}>Save this browser's setup</button>
      </form>
      <ErrorText error={load.error ?? save.error ?? action.error} />
    </section>
  );
}

function RecoveryKey() {
  const [status, setStatus] = useState<{ createdAt: number } | null>();
  const [shown, setShown] = useState<string>();
  const load = useAction(async () => setStatus(await call("recoveryStatus")));
  const create = useAction(async () => {
    if (status && !confirm("Replace your recovery key? The old one stops working.")) return;
    setShown(await call("createRecoveryKey"));
    await load.run();
  });
  useEffect(() => void load.run(), []);

  const download = (key: string) => {
    const text = `BrowserLace recovery key\n\n${key}\n\nKeep this somewhere safe and private. Anyone with it and access to your server account can read your synced bookmarks and tabs.\n`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = "browserlace-recovery-key.txt";
    link.click();
  };

  return (
    <section className="stack">
      <h2>Recovery key</h2>
      <div className="card stack">
        <p className="muted">
          Your encryption keys exist only on your devices. A recovery key lets you get back in if you lose all of them.
          {status === null && " You don't have one yet."}
          {status && ` Created ${timeAgo(status.createdAt)}.`}
        </p>
        {shown ? (
          <Notice>
            <p>Save this now. It won't be shown again.</p>
            <span className="code">{shown}</span>
            <div className="row">
              <button className="ghost" onClick={() => void navigator.clipboard.writeText(shown)}>
                Copy
              </button>
              <button className="ghost" onClick={() => download(shown)}>
                Download
              </button>
              <span className="spacer" />
              <button onClick={() => setShown(undefined)}>I've saved it</button>
            </div>
          </Notice>
        ) : (
          <div className="row">
            <button className={status === null ? "primary" : ""} disabled={create.pending || status === undefined} onClick={() => create.run()}>
              {status ? "Replace recovery key" : "Create recovery key"}
            </button>
            <ErrorText error={create.error ?? load.error} />
          </div>
        )}
      </div>
    </section>
  );
}

function ThisBrowser() {
  const config = useStored(configItem);
  const shareTabs = useStored(shareTabsItem);
  const rename = useAction(async (f: Record<string, string>) => call("renameDevice", { name: f.name! }));
  const share = useAction((enabled: boolean) => call("setShareTabs", { enabled }));
  const disconnect = useAction(async () => {
    if (confirm("Disconnect this browser? Its bookmarks stay; syncing stops and it's removed from your devices.")) {
      await call("disconnect");
    }
  });
  if (!config) return null;
  return (
    <section className="stack">
      <h2>This browser</h2>
      <div className="card stack">
        <form className="row" onSubmit={onSubmit(rename.run)}>
          <input name="name" required defaultValue={config.deviceName} aria-label="Device name" style={{ flex: 1 }} />
          <button disabled={rename.pending}>Rename</button>
        </form>
        <ErrorText error={rename.error} />
        <label className="inline">
          <input
            type="checkbox"
            checked={shareTabs ?? true}
            disabled={share.pending}
            onChange={(e) => share.run(e.target.checked)}
          />
          Share this browser's open tabs with my other devices
        </label>
        <p className="muted">Server: {config.serverUrl}</p>
        <div>
          <button className="danger" disabled={disconnect.pending} onClick={() => disconnect.run()}>
            Disconnect this browser
          </button>
        </div>
      </div>
    </section>
  );
}
