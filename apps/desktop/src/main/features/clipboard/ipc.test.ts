import { beforeEach, expect, it, vi } from "vitest"
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, PopupOptions } from "electron"

const native = vi.hoisted(() => ({
  items: [] as MenuItemConstructorOptions[],
  popup: null as PopupOptions | null,
  formats: ["image/png"],
  owner: { isDestroyed: () => false },
}))
vi.mock("electron", () => ({
  clipboard: { readText: () => "", writeText: () => {}, availableFormats: () => native.formats },
  BrowserWindow: { fromWebContents: () => native.owner },
  Menu: {
    buildFromTemplate: (items: MenuItemConstructorOptions[]) => {
      native.items = items
      return {
        popup: (options: PopupOptions) => {
          native.popup = options
        },
      }
    },
  },
}))
import { clipboardIpcContribution } from "./ipc"

beforeEach(() => {
  native.items = []
  native.popup = null
  native.formats = ["image/png"]
})
const event = { sender: {} } as unknown as IpcMainInvokeEvent
function handler() {
  const registration = clipboardIpcContribution
    .register({} as never)
    .find((entry) => entry.channel === "clipboard:show-text-menu")
  expect(registration, "clipboard edit menu must be registered").toBeDefined()
  return registration!.handler
}

it("offers only copy and conversation-scoped selection in a read-only message menu", async () => {
  const result = handler()(event, { editable: false, hasSelection: true })
  expect(native.items.map((item) => item.label)).toEqual(["复制", "全选"])
  expect(native.items.some((item) => item.role === "cut" || item.role === "paste")).toBe(false)
  native.items[0]!.click!({} as never, {} as never, {} as never)
  native.popup!.callback!()
  expect(await result).toBe("copy")
})
it("keeps native editor roles for rich copying, cutting and image pasting", async () => {
  const result = handler()(event, { editable: true, hasSelection: false })
  expect(native.items.filter((item) => item.type !== "separator").map((item) => item.role)).toEqual(
    ["cut", "copy", "paste", "selectAll"]
  )
  expect(native.items.find((item) => item.role === "cut")?.enabled).toBe(false)
  expect(native.items.find((item) => item.role === "copy")?.enabled).toBe(false)
  expect(native.items.find((item) => item.role === "paste")?.enabled).toBe(true)
  native.popup!.callback!()
  expect(await result).toBeNull()
})
it("disables paste when the system clipboard is empty", async () => {
  native.formats = []
  const result = handler()(event, { editable: true, hasSelection: true })
  expect(native.items.find((item) => item.role === "paste")?.enabled).toBe(false)
  native.popup!.callback!()
  await result
})
it("returns cancellation without choosing a clipboard action", async () => {
  const result = handler()(event, { editable: false, hasSelection: false })
  expect(native.items[0]?.enabled).toBe(false)
  native.popup!.callback!()
  expect(await result).toBeNull()
})
it.each([null, {}, { editable: "yes", hasSelection: true }])(
  "rejects invalid menu input: %j",
  (input) => {
    const showMenu = handler()
    expect(() => showMenu(event, input)).toThrow("无效的文本菜单请求")
    expect(native.items).toEqual([])
  }
)
