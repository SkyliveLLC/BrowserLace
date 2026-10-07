import { call } from "../lib/messages.ts";
import { collectionsItem, mountsItem, statusItem } from "../lib/storage.ts";
import { ErrorText, Notice, useAction, useStored } from "./ui.tsx";

/** Things that need the user: revoked device, failed syncs and paused mounts. */
export function Alerts({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const status = useStored(statusItem);
  const mounts = useStored(mountsItem) ?? {};
  const collections = useStored(collectionsItem) ?? [];
  const action = useAction((run: () => Promise<unknown>) => run());
  const name = (id: string) => collections.find((c) => c.id === id)?.name ?? "A collection";
  const settings = onOpenSettings && (
    <button className="link" onClick={onOpenSettings}>
      Open settings
    </button>
  );

  if (status?.revoked) {
    return (
      <Notice tone="danger">
        <p>This browser was removed from your BrowserLace account, so syncing stopped.</p>
        {settings}
      </Notice>
    );
  }

  return (
    <>
      {status?.error && <Notice tone="danger">Sync failed: {status.error}</Notice>}
      {Object.entries(status?.collectionErrors ?? {}).map(([id, error]) => (
        <Notice key={id} tone="warning">
          {name(id)}: {error}
        </Notice>
      ))}
      {Object.entries(mounts).map(([id, mount]) => {
        const paused = mount.paused;
        if (!paused) return null;
        if (paused.reason === "folder-missing") {
          return (
            <Notice key={id} tone="warning">
              <p>The folder “{name(id)}” syncs to was deleted. Choose a new folder or stop syncing it here.</p>
              {settings}
            </Notice>
          );
        }
        const local = paused.reason === "local-deletes";
        const send = mount.mode === "send";
        return (
          <Notice key={id} tone="warning">
            <p>
              {send
                ? `Sending this folder would delete ${paused.count} bookmarks from “${name(id)}” on your other devices. Go ahead?`
                : local
                  ? `You deleted ${paused.count} bookmarks from “${name(id)}”. Delete them on your other devices too?`
                  : `Syncing “${name(id)}” would remove ${paused.count} bookmarks from this browser.`}
            </p>
            <div className="row">
              <button
                disabled={action.pending}
                onClick={() => action.run(() => call("confirmDeletes", { collectionId: id }))}
              >
                {local ? "Delete everywhere" : "Remove them"}
              </button>
              {local && !send && (
                <button
                  disabled={action.pending}
                  onClick={() => action.run(() => call("discardDeletes", { collectionId: id }))}
                >
                  Put them back
                </button>
              )}
              {!local && settings}
            </div>
          </Notice>
        );
      })}
      <ErrorText error={action.error} />
    </>
  );
}
