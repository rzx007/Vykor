import {
  decodePluginUiBridgeMessage,
  encodePluginUiBridgeMessage,
  isPluginUiRecord,
  isPluginUiUuid,
  parsePluginUiBridgeReceipt,
  parsePluginUiBridgeSnapshot,
  PLUGIN_UI_BRIDGE_LIMITS,
  PluginUiBridgeError,
  readPluginUiBridgeNotification,
  readPluginUiBridgeResponse,
  parsePluginUiAppearance,
  parsePluginUiConversationReceipt,
  type PluginUiAppearance,
  type PluginUiConversationRequest,
  type PluginUiConversationReceipt,
  type JsonValue,
  type PluginUiActionReceipt,
  type PluginUiBridgeMethod,
  type PluginUiViewSnapshot,
} from "@vykor/protocol";

export type {
  PluginUiViewSnapshot,
  PluginUiActionReceipt,
  PluginUiAppearance,
  PluginUiConversationRequest,
  PluginUiConversationReceipt,
  JsonValue,
};
export interface PluginUiClient {
  getSnapshot(): Promise<PluginUiViewSnapshot>;
  onSnapshot(listener: (value: PluginUiViewSnapshot) => void): () => void;
  requestAction(
    actionId: string,
    args: Record<string, JsonValue>,
  ): Promise<PluginUiActionReceipt>;
  requestConversation(
    value: PluginUiConversationRequest,
  ): Promise<PluginUiConversationReceipt>;
  resize(height: number): Promise<void>;
  dismiss(): Promise<void>;
  dispose(): void;
}

/** A browser-only client: the transferred port is its sole host capability. */
export function createPluginUiClient(): Promise<PluginUiClient> {
  if (typeof window === "undefined" || window.parent === window)
    return Promise.reject(new PluginUiBridgeError("plugin_ui_unavailable"));
  return new Promise((initialize, rejectInitialization) => {
    let port: MessagePort | undefined;
    let mountId: string | undefined;
    let snapshot: PluginUiViewSnapshot | undefined;
    let disposed = false;
    let sequence = 0;
    const listeners = new Set<(value: PluginUiViewSnapshot) => void>();
    const pending = new Map<
      string,
      {
        method: PluginUiBridgeMethod;
        mode?: "draft" | "submit";
        expectedRevision?: number;
        resolve(value: unknown): void;
        reject(error: unknown): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const initializationTimer = setTimeout(
      () => dispose("plugin_ui_load_timeout"),
      PLUGIN_UI_BRIDGE_LIMITS.initializationMs,
    );

    function dispose(code = "plugin_ui_mount_closed"): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(initializationTimer);
      window.removeEventListener("message", onInitialize);
      if (port) {
        port.onmessage = null;
        port.onmessageerror = null;
        port.close();
      }
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new PluginUiBridgeError(code));
      }
      pending.clear();
      listeners.clear();
      rejectInitialization(new PluginUiBridgeError(code));
    }
    function acceptSnapshot(value: PluginUiViewSnapshot): void {
      if (snapshot && value.instanceId !== snapshot.instanceId)
        throw new PluginUiBridgeError("plugin_ui_invalid_message");
      if (snapshot && value.revision < snapshot.revision) return;
      const first = !snapshot;
      snapshot = structuredClone(value);
      if (first) {
        clearTimeout(initializationTimer);
        initialize(client);
      }
      for (const listener of listeners) {
        try {
          listener(structuredClone(snapshot));
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
    function receive(event: MessageEvent): void {
      if (disposed) return;
      let value: unknown;
      try {
        value = decodePluginUiBridgeMessage(
          event.data,
          PLUGIN_UI_BRIDGE_LIMITS.snapshotBytes,
        );
      } catch {
        return;
      }
      const notice = readPluginUiBridgeNotification(value);
      if (notice && notice.mountId === mountId) {
        if (notice.type === "dispose") dispose();
        else {
          try {
            acceptSnapshot(notice.snapshot);
          } catch {
            dispose("plugin_ui_invalid_message");
          }
        }
        return;
      }
      const response = readPluginUiBridgeResponse(value);
      if (!response || response.mountId !== mountId) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if ("error" in response) {
        request.reject(
          new PluginUiBridgeError(response.error.code, response.error.message),
        );
        return;
      }
      try {
        if (request.method === "getSnapshot") {
          acceptSnapshot(parsePluginUiBridgeSnapshot(response.result));
          request.resolve(structuredClone(snapshot!));
        } else if (request.method === "requestAction") {
          const receipt = parsePluginUiBridgeReceipt(response.result);
          if (receipt.instanceId !== snapshot!.instanceId)
            throw new PluginUiBridgeError("plugin_ui_invalid_message");
          request.resolve(receipt);
        } else if (request.method === "requestConversation") {
          const receipt = parsePluginUiConversationReceipt(response.result);
          if (
            receipt.instanceId !== snapshot!.instanceId ||
            receipt.mode !== request.mode ||
            request.expectedRevision === undefined ||
            receipt.revision !==
              request.expectedRevision + (request.mode === "submit" ? 1 : 0)
          )
            throw new PluginUiBridgeError("plugin_ui_invalid_message");
          request.resolve(receipt);
        } else {
          if (response.result !== null)
            throw new PluginUiBridgeError("plugin_ui_invalid_message");
          request.resolve(undefined);
        }
      } catch {
        request.reject(new PluginUiBridgeError("plugin_ui_invalid_message"));
      }
    }
    function onInitialize(event: MessageEvent): void {
      if (
        disposed ||
        port ||
        event.source !== window.parent ||
        event.ports?.length !== 1
      )
        return;
      const data = event.data;
      if (
        !isPluginUiRecord(data) ||
        Object.keys(data).length !== 3 ||
        data.version !== 2 ||
        data.type !== "plugin-ui-init" ||
        !isPluginUiUuid(data.mountId)
      )
        return;
      const transferred = event.ports[0];
      if (!transferred || typeof transferred.postMessage !== "function") return;
      mountId = data.mountId;
      port = transferred;
      window.removeEventListener("message", onInitialize);
      port.onmessage = receive;
      port.onmessageerror = () => dispose("plugin_ui_invalid_message");
      port.start();
    }
    async function request(
      method: PluginUiBridgeMethod,
      params: Record<string, unknown>,
    ): Promise<unknown> {
      if (disposed || !port || !snapshot)
        throw new PluginUiBridgeError("plugin_ui_mount_closed");
      if (pending.size >= PLUGIN_UI_BRIDGE_LIMITS.pendingRequests)
        throw new PluginUiBridgeError("plugin_ui_rate_limited");
      const id = String(++sequence);
      const wire = encodePluginUiBridgeMessage({
        version: 2,
        mountId,
        id,
        method,
        params,
      });
      return await new Promise((resolve, reject) => {
        const duration =
          method === "requestAction" ||
          method === "dismiss" ||
          method === "requestConversation"
            ? PLUGIN_UI_BRIDGE_LIMITS.confirmedRequestMs
            : PLUGIN_UI_BRIDGE_LIMITS.requestMs;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new PluginUiBridgeError("plugin_ui_request_timeout"));
        }, duration);
        pending.set(id, {
          method,
          mode:
            method === "requestConversation"
              ? (params.mode as "draft" | "submit")
              : undefined,
          expectedRevision:
            method === "requestConversation"
              ? (params.expectedRevision as number)
              : undefined,
          resolve,
          reject,
          timer,
        });
        try {
          port!.postMessage(wire);
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new PluginUiBridgeError("plugin_ui_invalid_message"));
        }
      });
    }
    const client: PluginUiClient = {
      getSnapshot: async () =>
        (await request("getSnapshot", {})) as PluginUiViewSnapshot,
      onSnapshot: (listener) => {
        if (disposed) throw new PluginUiBridgeError("plugin_ui_mount_closed");
        listeners.add(listener);
        listener(structuredClone(snapshot!));
        return () => {
          listeners.delete(listener);
        };
      },
      requestAction: async (actionId, args) => {
        if (disposed) throw new PluginUiBridgeError("plugin_ui_mount_closed");
        if (snapshot!.readOnly)
          throw new PluginUiBridgeError("plugin_ui_read_only");
        if (!snapshot!.actions.some((action) => action.id === actionId))
          throw new PluginUiBridgeError("plugin_ui_invalid_action");
        return (await request("requestAction", {
          actionId,
          args: structuredClone(args),
          expectedRevision: snapshot!.revision,
        })) as PluginUiActionReceipt;
      },
      requestConversation: async (value) => {
        if (disposed) throw new PluginUiBridgeError("plugin_ui_mount_closed");
        if (value.mode !== "draft" && value.mode !== "submit")
          throw new PluginUiBridgeError("plugin_ui_invalid_message");
        if (!snapshot!.capabilities[value.mode])
          throw new PluginUiBridgeError("plugin_ui_read_only");
        return (await request(
          "requestConversation",
          structuredClone(value) as unknown as Record<string, unknown>,
        )) as PluginUiConversationReceipt;
      },
      resize: async (height) => {
        await request("resize", { height });
      },
      dismiss: async () => {
        if (disposed) throw new PluginUiBridgeError("plugin_ui_mount_closed");
        if (snapshot!.status !== "open")
          throw new PluginUiBridgeError("plugin_ui_read_only");
        if (snapshot!.activeAction)
          throw new PluginUiBridgeError("plugin_ui_session_busy");
        await request("dismiss", { expectedRevision: snapshot!.revision });
      },
      dispose: () => dispose(),
    };
    window.addEventListener("message", onInitialize);
    window.parent.postMessage({ version: 2, type: "plugin-ui-ready" }, "*");
  });
}

/** Apply only the public palette and typography variables to an independent plugin document. */
export function applyPluginUiAppearance(
  value: PluginUiAppearance,
  root: HTMLElement = document.documentElement,
): void {
  const appearance = parsePluginUiAppearance(value);
  const variables = [
    ["background", "--ohs-background"],
    ["foreground", "--ohs-foreground"],
    ["muted", "--ohs-muted"],
    ["mutedForeground", "--ohs-muted-foreground"],
    ["primary", "--ohs-primary"],
    ["primaryForeground", "--ohs-primary-foreground"],
    ["accent", "--ohs-accent"],
    ["border", "--ohs-border"],
    ["destructive", "--ohs-destructive"],
  ] as const;
  for (const [name] of variables) {
    if (
      typeof CSS === "undefined" ||
      !CSS.supports("color", appearance.colors[name])
    )
      throw new PluginUiBridgeError("plugin_ui_invalid_message");
  }
  for (const [name, variable] of variables)
    root.style.setProperty(variable, appearance.colors[name]);
  root.style.setProperty("--ohs-font-family", appearance.fontFamily);
  root.style.setProperty("--ohs-font-size", `${appearance.fontSizePx}px`);
  root.style.setProperty("--ohs-color-scheme", appearance.theme);
  root.style.setProperty(
    "--ohs-motion-duration",
    appearance.reducedMotion ? "0ms" : "120ms",
  );
}
