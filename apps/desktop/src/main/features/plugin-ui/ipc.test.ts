import { expect, it } from "vitest";
import { createPluginUiIpcContribution } from "./ipc";
import { IpcChannels } from "../../../shared/ipc-channels";
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
