import { expect, it } from "vitest"
import { App } from "@modelcontextprotocol/ext-apps"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js"
it("does not expose the optional namespace or accept set-widget-state through the official protocol", async () => {
  const bridge = new AppBridge(null, { name: "host", version: "1" }, {})
  const app = new App({ name: "fixture", version: "1" }, { experimental: { "vykor/widgetState": {} } }, { autoResize: false })
  const [hostTransport, pageTransport] = InMemoryTransport.createLinkedPair()
  try {
    await bridge.connect(hostTransport); await app.connect(pageTransport)
    expect(app.getHostCapabilities()?.experimental).toBeUndefined()
    expect(bridge.getAppCapabilities()?.experimental).toEqual({})
    // @ts-expect-error Deliberately send an unsupported method to verify the real protocol rejects it.
    await expect(app.request({ method: "ui/set-widget-state", params: { state: { draft: "test" } } }, EmptyResultSchema)).rejects.toThrow()
  } finally { await app.close(); await bridge.close() }
})
