/**
 * Live notifications. Devices hold a WebSocket open and are told when something in their
 * account changed, so they sync right away instead of on the next alarm. Events carry no
 * content, only what kind of thing changed and which device changed it.
 */

export type ServerEvent = {
  type: "changes" | "collections" | "keys" | "tabs" | "sends";
  /** The device whose write caused it, so it can ignore its own events. */
  from: string;
  collectionId?: string;
};

type Subscriber = { deviceId: string; send: (event: ServerEvent) => void; close: () => void };

export class Events {
  private accounts = new Map<string, Set<Subscriber>>();

  /** Starts delivering the account's events. Returns the unsubscribe function. */
  subscribe(accountId: string, subscriber: Subscriber): () => void {
    const subscribers = this.accounts.get(accountId) ?? new Set();
    subscribers.add(subscriber);
    this.accounts.set(accountId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.accounts.delete(accountId);
    };
  }

  publish(accountId: string, event: ServerEvent) {
    for (const subscriber of this.accounts.get(accountId) ?? []) subscriber.send(event);
  }

  /** Closes a removed device's connections. */
  disconnect(accountId: string, deviceId: string) {
    for (const subscriber of this.accounts.get(accountId) ?? []) if (subscriber.deviceId === deviceId) subscriber.close();
  }

  /** Closes every connection, for shutdown. */
  closeAll() {
    for (const subscribers of this.accounts.values()) for (const subscriber of subscribers) subscriber.close();
  }
}
