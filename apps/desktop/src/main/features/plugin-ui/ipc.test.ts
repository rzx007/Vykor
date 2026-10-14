import { expect, it } from "vitest";
import { createPluginUiIpcContribution } from "./ipc";
import { IpcChannels } from "../../../shared/ipc-channels";
it.each(["prepareConversation", "submitConversation", "getConversationSubmission"])("routes %s only through the registered main frame", async method => {
  const service = { isOwner: (id: number) => id === 42, [method]: async (id: number, input: unknown) => ({ id, input }) };
  const handler = createPluginUiIpcContribution(() => service as never).register({} as never)
    .find(item => item.channel === `plugin-ui:${method.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())}`)?.handler;
  expect(handler).toBeTypeOf("function");
  const main = {}, sender = { id: 42, mainFrame: main, isDestroyed: () => false };
  expect(() => handler!({ sender, senderFrame: {} } as never, {})).toThrow("plugin_ui_mount_closed");
  await expect(handler!({ sender, senderFrame: main } as never, { requestId: "id" })).resolves.toEqual({ id: 42, input: { requestId: "id" } });
});
it("rejects child-frame and unregistered IPC before invoking the service", async () => {
  let calls = 0;
  const service = { isOwner: (id: number) => id === 42,
    capabilities: async () => { calls++; return { available: true }; } };
  const handlers = createPluginUiIpcContribution(() => service as never).register({} as never);
  const handler = handlers.find(item => item.channel === IpcChannels.pluginUiCapabilities)!.handler;
  const main = {};
  const sender = { id: 42, mainFrame: main, isDestroyed: () => false };
  expect(() => handler({ sender, senderFrame: {} } as never)).toThrow("plugin_ui_mount_closed");
  expect(() => handler({ sender: { ...sender, id: 43 }, senderFrame: main } as never)).toThrow("plugin_ui_mount_closed");
  expect(calls).toBe(0);
  await expect(handler({ sender, senderFrame: main } as never)).resolves.toEqual({ available: true });
});
