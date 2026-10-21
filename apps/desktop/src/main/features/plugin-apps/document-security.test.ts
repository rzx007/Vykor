import { expect, it, vi } from "vitest"
import { registerIsolatedDocumentPolicy } from "./document-security"
it("installs one session listener and preserves both scheme owners and retired-frame network blocks", () => {
  const onBeforeRequest = vi.fn(), session = { webRequest: { onBeforeRequest } }
  const old = { authorizeRequest: vi.fn(() => true), isPluginFrame: (_owner: number, frame: number) => frame === 7 }
  const next = { authorizeRequest: vi.fn(() => true), isPluginFrame: (_owner: number, frame: number) => frame === 8 }
  registerIsolatedDocumentPolicy(session as never, "isolated-fixture", old)
  registerIsolatedDocumentPolicy(session as never, "vykor-plugin-app", next)
  expect(onBeforeRequest).toHaveBeenCalledTimes(1)
  const handle = onBeforeRequest.mock.calls[0]![0]
  const call = (url: string, frameId: number, parent = 1) => {
    const callback = vi.fn(); handle({ url, webContentsId: 42, resourceType: "subFrame", method: "GET",
      webContents: { mainFrame: { frameTreeNodeId: 1 } }, frame: { frameTreeNodeId: frameId, parent: { frameTreeNodeId: parent } } }, callback)
    return callback.mock.calls[0]![0]
  }
  expect(call("isolated-fixture://frame/id", 2)).toEqual({ cancel: false })
  expect(call("vykor-plugin-app://frame/id", 3)).toEqual({ cancel: false })
  expect(old.authorizeRequest).toHaveBeenCalledTimes(1); expect(next.authorizeRequest).toHaveBeenCalledTimes(1)
  expect(call("https://outside.test", 7)).toEqual({ cancel: true })
  expect(call("vykor-plugin-app://frame/id", 8)).toEqual({ cancel: true })
  expect(call("https://outside.test", 9, 7)).toEqual({ cancel: true })
})
