import { expect, it, vi } from "vitest"
import { createPluginAppsIpcContribution } from "./ipc"
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
