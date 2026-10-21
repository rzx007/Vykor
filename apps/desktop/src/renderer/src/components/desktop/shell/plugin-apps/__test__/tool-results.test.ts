// @vitest-environment jsdom
import { expect, it, vi } from "vitest"
import { PluginAppController } from "../controller"
import { PluginAppTransport } from "../transport"
import { mount } from "./fixtures.test-support"
const host = vi.hoisted(() => ({ initialize: () => {}, release: () => {}, sent: [] as string[] }))
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: class {
  oninitialized?: () => void
  constructor() { host.initialize = () => this.oninitialized?.() }
  setRequestHandler() {}
  getAppCapabilities() { return {} }
  setHostContext() {}
  async sendToolInput(value: { arguments: { part: string } }) {
    host.sent.push(`input:${value.arguments.part}`)
    if (value.arguments.part === "a") await new Promise<void>(resolve => { host.release = resolve })
  }
  async sendToolResult(value: { content: Array<{ text: string }> }) { host.sent.push(`result:${value.content[0]!.text}`) }
} }))
it("serializes distinct trusted Parts after initialization without repeating a clicked Part", async () => {
  const transport = new PluginAppTransport(document.createElement("iframe"), new PluginAppController(mount, {} as never, async () => true))
  const input = (part: string) => ({ sourcePartId: part, arguments: { part }, result: { content: [{ type: "text", text: part }] } })
  transport.queueToolResult(input("a")); transport.queueToolResult(input("a"))
  expect(host.sent).toEqual([]); host.initialize()
  await vi.waitFor(() => expect(host.sent).toEqual(["input:a"]))
  transport.queueToolResult(input("b")); transport.queueToolResult(input("b"))
  expect(host.sent).toEqual(["input:a"]); host.release()
  await vi.waitFor(() => expect(host.sent).toEqual(["input:a", "result:a", "input:b", "result:b"]))
})
