// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { McpUiHostCapabilitiesSchema, McpUiAppCapabilitiesSchema } from "@modelcontextprotocol/ext-apps"
import { PluginAppController } from "../controller"
import { PluginAppTransport } from "../transport"
import { mount } from "./fixtures.test-support"
const host = vi.hoisted(() => ({ capabilities: {} as Record<string, unknown>, requests: [] as string[], contexts: [] as Record<string, unknown>[] }))
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: class {
  constructor(_client: unknown, _info: unknown, capabilities: Record<string, unknown>) { host.capabilities = capabilities }
  setRequestHandler(schema: { shape: { method: { value: string } } }) { host.requests.push(schema.shape.method.value) }
  setHostContext(context: Record<string, unknown>) { host.contexts.push(context) }
} }))
afterEach(() => { host.contexts = []; host.requests = []; document.documentElement.classList.remove("dark"); document.documentElement.style.removeProperty("--font-sans"); document.documentElement.style.removeProperty("--font-mono") })
it("records why SDK 1.1.2 cannot negotiate the optional namespace through its public capability schemas", () => {
  const caps = { experimental: { "vykor/widgetState": {} } }
  expect(McpUiHostCapabilitiesSchema.parse(caps).experimental).toEqual({})
  expect(McpUiAppCapabilitiesSchema.parse(caps).experimental).toEqual({})
})
it("does not advertise unassembled APIs or widgetState and keeps theme changes independent of drafts", () => {
  const controller = new PluginAppController(mount, {} as never, async () => true)
  const transport = new PluginAppTransport(document.createElement("iframe"), controller)
  expect(host.capabilities).not.toHaveProperty("message")
  expect(host.capabilities).not.toHaveProperty("updateModelContext")
  expect(host.capabilities).not.toHaveProperty("experimental")
  expect(host.requests).not.toContain("ui/set-widget-state")
  document.documentElement.classList.add("dark")
  document.documentElement.style.setProperty("--font-sans", 'Arial, "PingFang SC", sans-serif')
  document.documentElement.style.setProperty("--font-mono", '"JetBrains Mono", monospace')
  transport.updateContext()
  expect(host.contexts.at(-1)).toMatchObject({ theme: "dark", styles: { variables: {
    "--font-sans": 'Arial, "PingFang SC", sans-serif',
    "--font-mono": '"JetBrains Mono", monospace',
  } } })
  expect(host.contexts.at(-1)).not.toHaveProperty("vykor/widgetState")
})
