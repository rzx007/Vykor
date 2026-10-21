import { expect, it, vi } from "vitest"
import { createPluginAppsIpcContribution } from "./ipc"
import { PluginAppBusyError } from "./plugin-app-service"
it("only routes finite calls from a registered main frame", async () => {
  const invokeTool = vi.fn(async () => ({ receipt: {} }))
  const handlers = createPluginAppsIpcContribution(() => ({ isOwner: (id: number) => id === 42, invokeTool }) as never).register({} as never)
  const handler = handlers.find(item => item.channel === "plugin-apps:invokeTool")!.handler
  const main = {}, sender = { id: 42, mainFrame: main, isDestroyed: () => false }
  expect(() => handler({ sender, senderFrame: {} } as never, {})).toThrow("owner_unavailable")
  expect(() => handler({ sender: { ...sender, id: 43 }, senderFrame: main } as never, {})).toThrow("owner_unavailable")
  await handler({ sender, senderFrame: main } as never, { mountId: "mount", requestId: "request" })
  expect(invokeTool).toHaveBeenCalledExactlyOnceWith(42, { mountId: "mount", requestId: "request" })
})
it("transports only Main-verified busy rejection as structured data before Electron can erase Error fields", async () => {
  const invokeTool = vi.fn(async () => { throw new PluginAppBusyError("original-request") })
  const handlers = createPluginAppsIpcContribution(() => ({ isOwner: () => true, invokeTool }) as never).register({} as never)
  const handler = handlers.find(item => item.channel === "plugin-apps:invokeTool")!.handler
  const main = {}, event = { sender: { id: 42, mainFrame: main, isDestroyed: () => false }, senderFrame: main }
  const result = await handler(event as never, { mountId: "mount", requestId: "original-request" })
  expect(structuredClone(result)).toEqual({ code: "plugin_app_busy", notAccepted: true, requestId: "original-request" })
  invokeTool.mockRejectedValueOnce(new Error("plugin_app_busy"))
  await expect(handler(event as never, { mountId: "mount", requestId: "original-request" })).rejects.toThrow("plugin_app_busy")
})
