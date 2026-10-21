import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { EmptyResultSchema, ReadResourceResultSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// 此文件属于本插件，只封装页面使用的能力；线协议和类型由官方 SDK 提供。
export function createClient(
  app = new App({ name: "excalidraw", version: "1.0.0" }, {}, { autoResize: false }),
) {
  let toolInput: Record<string, unknown> | null = null;
  let toolOutput: unknown = null;
  let toolCancelled: { reason?: string } | null = null;
  let tabState: unknown = null;
  let connection: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
    window.dispatchEvent(new Event("plugin:change"));
  };
  // 处理器必须先于 connect 注册，加载大型 UI 期间收到的首个结果仍由此实例保存。
  app.ontoolinput = (input) => {
    toolInput = input.arguments ?? {};
    notify();
  };
  app.ontoolresult = (result) => {
    toolOutput = result.structuredContent ?? null;
    notify();
  };
  app.ontoolcancelled = (event) => {
    toolCancelled = event.reason ? { reason: event.reason } : {};
    notify();
  };
  app.onhostcontextchanged = context => { if (context.styles?.variables) applyHostStyleVariables(context.styles.variables); notify(); };
  app.setNotificationHandler(ResourceListChangedNotificationSchema, notify);
  const ready = () =>
    (connection ??= app.connect().then(() => {
      const context = app.getHostContext();
      if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
      notify();
    }));
  const run = <T>(operation: () => Promise<T>): Promise<T> => ready().then(operation);
  return {
    app,
    ready,
    get toolInput() {
      return toolInput;
    },
    get toolOutput() {
      return toolOutput;
    },
    get toolCancelled() {
      return toolCancelled;
    },
    get theme() {
      return app.getHostContext()?.theme ?? null;
    },
    get locale() {
      return app.getHostContext()?.locale ?? null;
    },
    get displayMode() {
      return app.getHostContext()?.displayMode ?? null;
    },
    get hostContext() {
      return app.getHostContext() ?? null;
    },
    get tabState() {
      return tabState;
    },
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      run(() => app.callServerTool({ name, arguments: args })),
    readResource: (uri: string) => run(() => app.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema)),
    async setTabState(state: unknown) {
      await ready();
      tabState = state;
    },
    subscribeResource: (uri: string) => run(() => app.request({ method: "resources/subscribe", params: { uri } }, EmptyResultSchema)),
    updateModelContext: (input: Parameters<App["updateModelContext"]>[0]) =>
      run(() => app.updateModelContext(input)).then(() => undefined),
    sendFollowUpMessage: (input: { prompt: string; structuredContent?: Record<string, unknown> }) =>
      run(() =>
        app.sendMessage({
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    notifyIntrinsicHeight: (height: number) => {
      void run(() => app.sendSizeChanged({ height })).catch(() => undefined);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type PluginClient = ReturnType<typeof createClient>;
export type ToolResult<T = unknown> = Awaited<ReturnType<App["callServerTool"]>> & {
  structuredContent?: T;
};
declare global {
  interface Window {
    __pluginClient?: PluginClient;
  }
}
export function getClient(): PluginClient {
  // 加载页与延后执行的 UI bundle 共用一个实例，不能重复连接宿主。
  return (window.__pluginClient ??= createClient());
}
