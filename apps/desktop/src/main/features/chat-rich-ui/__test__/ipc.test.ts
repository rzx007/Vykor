import { assert, expect, it, vi } from "vitest"
import { IpcChannels } from "../../../../shared/ipc-channels"
import type { RichUiLoadResult } from "../../../../shared/rich-ui-content"
import type { AppContext } from "../../../core/app-context"
import { desktopPluginAppDocuments } from "../../plugin-apps/document-protocol"
import { chatRichUiIpcContribution } from "../ipc"

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), fetchImage: vi.fn(), lookup: vi.fn() }))
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }))
vi.mock("electron", () => ({
  session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
}))
vi.mock("../../settings/settings-service", () => ({
  desktopSettingsService: { getRichUiEnabled: mocks.enabled },
}))
vi.mock("../image-fetch", () => ({ fetchRichImage: mocks.fetchImage }))
vi.mock("../../plugin-apps/document-protocol", async () => {
  const { PluginAppDocumentStore } = await import("../../plugin-apps/document-store")
  return { desktopPluginAppDocuments: new PluginAppDocumentStore() }
})

const rendererUrl = "http://localhost:5173/"
const mainFrame = { url: rendererUrl + "#/conversation/example" }
const sender = { id: 42, mainFrame, isDestroyed: () => false }
const event = { sender, senderFrame: mainFrame } as never
const ctx = {
  paths: { rendererUrl },
  windowManager: { getMain: () => ({ webContents: sender }) },
} as unknown as AppContext
const handlers = chatRichUiIpcContribution.register(ctx)
const load = handlers.find((item) => item.channel === IpcChannels.richUiLoad)!.handler
const release = handlers.find((item) => item.channel === IpcChannels.richUiRelease)!.handler

it("checks the current setting before new work and leaves an existing preview alive", async () => {
  mocks.enabled.mockReturnValue(true)
  const html = { kind: "html", title: "预览", html: "<script>document.title='ready'</script>" }
  const result = (await load(event, html)) as RichUiLoadResult
  assert(result.kind === "frame")
  const url = `vykor-plugin-app://frame/${result.mountId}`
  expect(
    desktopPluginAppDocuments.authorizeRequest({
      ownerId: 42,
      url,
      method: "GET",
      resourceType: "subFrame",
      frameTreeNodeId: 7,
      parentFrameTreeNodeId: 1,
      mainFrameTreeNodeId: 1,
    })
  ).toBe(true)
  const response = desktopPluginAppDocuments.respond(new Request(url))
  expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'")
  expect(await response.text()).toBe(html.html)

  mocks.enabled.mockReturnValue(false)
  await expect(
    load(event, { kind: "image", title: "图片", url: "https://example.test/image" })
  ).resolves.toEqual({ kind: "disabled" })
  expect(mocks.fetchImage).not.toHaveBeenCalled()
  expect(desktopPluginAppDocuments.owns(result.mountId, 42, undefined, true)).toBe(true)
  release(event, result.mountId)
  expect(desktopPluginAppDocuments.owns(result.mountId, 42)).toBe(false)
})

it("rejects embedded IPC senders, invalid URLs and local video sources", async () => {
  mocks.enabled.mockReturnValue(true)
  const video = { kind: "video", title: "视频", url: "https://example.test/player" }
  await expect(load({ sender, senderFrame: { url: rendererUrl } } as never, video)).rejects.toThrow(
    "主窗口"
  )
  await expect(load(event, { ...video, url: "file:///C:/video.mp4" })).rejects.toThrow("不符合格式")
  await expect(load(event, { ...video, url: "https://127.0.0.1/video.mp4" })).rejects.toThrow(
    "公开网络"
  )
})

it("mounts a public video from a site without a provider adapter", async () => {
  mocks.enabled.mockReturnValue(true)
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }])
  const result = (await load(event, {
    kind: "video",
    title: "视频",
    url: "https://player.example.test/embed?id=3&autoplay=0",
  })) as RichUiLoadResult
  assert(result.kind === "frame")
  const url = `vykor-plugin-app://frame/${result.mountId}`
  expect(
    desktopPluginAppDocuments.authorizeRequest({
      ownerId: 42,
      url,
      method: "GET",
      resourceType: "subFrame",
      frameTreeNodeId: 8,
      parentFrameTreeNodeId: 1,
      mainFrameTreeNodeId: 1,
    })
  ).toBe(true)
  const response = desktopPluginAppDocuments.respond(new Request(url))
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "frame-src https://player.example.test"
  )
  expect(await response.text()).toContain(
    'src="https://player.example.test/embed?id=3&amp;autoplay=0" credentialless'
  )
  release(event, result.mountId)
})
