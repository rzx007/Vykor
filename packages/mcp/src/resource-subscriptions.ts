import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  McpError,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** One handler per concrete client. Reference counts and serialized transitions prevent a late
 * unsubscribe from cancelling a newer reader of the same URI. No payloads are retained. */
class ResourceSubscriptions {
  private readonly entries = new Map<
    string,
    { listeners: Set<() => void>; work: Promise<void>; subscribed: boolean }
  >();
  constructor(private readonly client: Client) {
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        for (const listener of this.entries.get(notification.params.uri)
          ?.listeners ?? [])
          listener();
      },
    );
  }
  async subscribe(
    uri: string,
    listener: () => void,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<() => void> {
    signal.throwIfAborted();
    let entry = this.entries.get(uri);
    if (!entry) {
      entry = {
        listeners: new Set(),
        work: Promise.resolve(),
        subscribed: false,
      };
      this.entries.set(uri, entry);
    }
    const selected = entry;
    const guarded = () => {
      if (!signal.aborted && current()) listener();
    };
    let active = true;
    const reconcile = () => {
      selected.work = selected.work
        .catch(() => {})
        .then(async () => {
          if (selected.listeners.size && !selected.subscribed) {
            await this.client.subscribeResource({ uri });
            selected.subscribed = true;
          }
          if (!selected.listeners.size && selected.subscribed) {
            await this.client.unsubscribeResource({ uri });
            selected.subscribed = false;
          }
          if (
            !selected.listeners.size &&
            !selected.subscribed &&
            this.entries.get(uri) === selected
          )
            this.entries.delete(uri);
        });
      return selected.work;
    };
    const stop = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", stop);
      selected.listeners.delete(guarded);
      void reconcile().catch(() => {});
    };
    selected.listeners.add(guarded);
    signal.addEventListener("abort", stop, { once: true });
    try {
      await reconcile();
      if (signal.aborted || !current()) {
        stop();
        throw new Error("plugin_app_backend_changed");
      }
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  }
}
const clients = new WeakMap<Client, ResourceSubscriptions>();
export function subscribeAppResource(
  client: Client,
  uri: string,
  listener: () => void,
  current: () => boolean,
  signal: AbortSignal,
): Promise<() => void> {
  let subscriptions = clients.get(client);
  if (!subscriptions) {
    subscriptions = new ResourceSubscriptions(client);
    clients.set(client, subscriptions);
  }
  return subscriptions
    .subscribe(uri, listener, current, signal)
    .catch((error) => {
      // Only a protocol invalid-params rejection of this subscribe is URI-local. Read/lease
      // authorization is checked by the caller and auth, transport and lifecycle errors propagate.
      if (
        error instanceof McpError &&
        error.code === ErrorCode.InvalidParams &&
        !signal.aborted &&
        current()
      )
        return () => {};
      throw error;
    });
}
