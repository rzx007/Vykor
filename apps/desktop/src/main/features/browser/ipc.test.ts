import { beforeEach, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ window: vi.fn(), read: vi.fn(), mode: vi.fn(), add: vi.fn(), focus: vi.fn(), remove: vi.fn() }))
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: state.window } }))
vi.mock("./browser-agent-service", () => ({ browserAgentService: {
  readAnnotations: state.read, setAnnotationMode: state.mode, addAnnotation: state.add,
  focusAnnotation: state.focus, removeAnnotation: state.remove,
} }))
import { browserIpcContribution } from "./ipc"
import { IpcChannels } from "../../../shared/ipc-channels"
const sender = { id: 7 }
beforeEach(() => { vi.clearAllMocks(); state.window.mockReturnValue({ webContents: sender }) })
function handler(channel: string) { return browserIpcContribution.register({} as never).find(r => r.channel === channel)!.handler }
it("rejects a sender belonging to a different WebContents", async () => {
  const read = handler(IpcChannels.browserReadAnnotations)
  state.window.mockReturnValue({ webContents: { id: 8 } })
  await expect(async () => read({ sender } as never, { tabId: "tab-1" })).rejects.toThrow()
})
it("rejects malformed annotation inputs before the service can select a guest", async () => {
  const read = handler(IpcChannels.browserReadAnnotations), mode = handler(IpcChannels.browserSetAnnotationMode)
  for (const input of [null, [], { tabId: 42 }, { tabId: "x".repeat(101) }]) {
    await expect(async () => read({ sender } as never, input)).rejects.toThrow()
  }
  for (const input of [{ tabId: "tab-1", pageRevision: NaN, mode: "pick" }, { tabId: "tab-1", pageRevision: 0, mode: "execute" }]) {
    await expect(async () => mode({ sender } as never, input)).rejects.toThrow()
  }
  expect(state.read).not.toHaveBeenCalled(); expect(state.mode).not.toHaveBeenCalled()
})
it("does not allow script or selector parameters in a save request", async () => {
  await expect(async () => handler(IpcChannels.browserAddAnnotation)({ sender } as never, {
    tabId: "tab-1", pageRevision: 0, selectionId: "s-1", comment: "意见", selector: "body", script: "alert(1)",
  })).rejects.toThrow()
  expect(state.add).not.toHaveBeenCalled()
})
