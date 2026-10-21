import { expect, it, vi } from "vitest"
import { App } from "@modelcontextprotocol/ext-apps"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { PluginAppController } from "../controller"
import { installAppHandlers } from "../handlers"
import { mount } from "./fixtures.test-support"

it.each(["busy", "hidden", "hidden-during-prepare"] as const)("delivers a structured %s non-admission proof through the official AppBridge", async reason => {
  const invokeTool = vi.fn(async () => ({ code: "plugin_app_busy", notAccepted: true, requestId: "fixed" }))
  let controller: PluginAppController
  const prepareTool = vi.fn(async () => {
    if (reason === "hidden-during-prepare") controller.setVisible(false)
    return { requestId: "fixed", toolName: "save", expectedRevision: 2, args: {}, policy: { confirmation: "granted", maxArgumentsBytes: 1024 } }
  })
  controller = new PluginAppController(mount, { prepareTool, invokeTool, cancelTool: vi.fn(async () => {}), refresh: async () => mount.state } as never, async () => true)
  if (reason === "hidden") controller.setVisible(false)
  const bridge = new AppBridge(null, { name: "host", version: "1" }, { serverTools: {} })
  const app = new App({ name: "page", version: "1" }, {}, { autoResize: false })
  installAppHandlers(bridge, controller)
  const [host, page] = InMemoryTransport.createLinkedPair()
  try {
    await bridge.connect(host); await app.connect(page)
    await expect(app.callServerTool({ name: "save", arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest,
      data: { code: reason === "busy" ? "plugin_app_busy" : "plugin_app_hidden", notAccepted: true } })
    expect(invokeTool).toHaveBeenCalledTimes(reason === "busy" ? 1 : 0)
  } finally { await app.close(); await bridge.close() }
})

it.each(["network", "plugin_app_busy", "Error invoking remote method 'plugin-apps:invokeTool': Error: plugin_app_busy"])("never promotes an unverified error string into retry authority: %s", async message => {
  const invokeTool = vi.fn(async () => { throw new Error(message) })
  const controller = new PluginAppController(mount, { prepareTool: async () => ({ requestId: "fixed", toolName: "save", expectedRevision: 2, args: {},
    policy: { confirmation: "granted", maxArgumentsBytes: 1024 } }), invokeTool, refresh: async () => mount.state } as never, async () => true)
  const error = await controller.callTool("save", {}, new AbortController().signal).catch(error => error)
  expect(error.message).toContain(message)
  expect(error.data).toBeUndefined()
  expect(invokeTool).toHaveBeenCalledTimes(1)
})

it("rejects a structured busy proof belonging to another prepared request", async () => {
  const controller = new PluginAppController(mount, { prepareTool: async () => ({ requestId: "fixed", toolName: "save", expectedRevision: 2, args: {},
    policy: { confirmation: "granted", maxArgumentsBytes: 1024 } }), invokeTool: async () => ({ code: "plugin_app_busy", notAccepted: true, requestId: "other" }),
    refresh: async () => mount.state } as never, async () => true)
  const error = await controller.callTool("save", {}, new AbortController().signal).catch(error => error)
  expect(error.data).toBeUndefined()
})
