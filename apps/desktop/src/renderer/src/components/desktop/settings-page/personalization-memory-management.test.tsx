// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PersonalizationManagementSnapshot } from "@shared/personalization-management-types"
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (select: (state: unknown) => unknown) =>
    select({ projects: [{ id: "project", name: "Project" }] }),
}))
vi.mock("@renderer/components/ui/select", () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: {
    value: string
    disabled?: boolean
    onValueChange(value: string): void
    children: ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))
import { PersonalizationMemoryManagement } from "./personalization-memory-management"
let container: HTMLDivElement
let root: Root
let stored: PersonalizationManagementSnapshot
const updateEntry = vi.fn()
const removeEntry = vi.fn()
beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  stored = {
    effective: {
      enabled: true,
      autoExtractEnabled: true,
      sessionMemoryEnabled: true,
      autoDreamEnabled: false,
      autoDreamMinHours: 24,
      autoDreamMinSessions: 5,
    },
    configured: null,
    sources: {},
    rules: [],
    consolidation: { status: "unknown", lastConsolidatedAt: null },
    entries: [
      { id: "memory", content: "Original memory", createdAt: 1, updatedAt: 1, revision: "r1" },
    ],
    managementAvailable: true,
    projectId: "project",
    projectPath: "/project",
    directory: "/data/memory/project",
  }
  updateEntry.mockReset()
  removeEntry.mockReset()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      personalizationManagement: {
        snapshot: vi.fn(async () => structuredClone(stored)),
        updateEntry,
        removeEntry,
      },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text
  )!
}
async function selectProject() {
  await act(async () => root.render(<PersonalizationMemoryManagement />))
  await act(async () => {
    const selector = container.querySelector("select")!
    selector.value = "project"
    selector.dispatchEvent(new Event("change", { bubbles: true }))
  })
}
it("retains a rejected draft and lets the user compare and adopt the latest revision", async () => {
  await selectProject()
  await act(async () => {
    ;[...container.querySelectorAll("button")]
      .find((item) => item.textContent?.startsWith("Original memory"))!
      .click()
  })
  await act(async () => button("编辑记忆").click())
  await act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="项目记忆内容"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "My draft"
    )
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  updateEntry.mockRejectedValueOnce(new Error("其他任务已修改记忆"))
  await act(async () => button("保存记忆").click())
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="项目记忆内容"]')?.value).toBe(
    "My draft"
  )
  stored.entries[0] = { ...stored.entries[0]!, content: "External memory", revision: "r2" }
  await act(async () => button("重新读取").click())
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="最新项目记忆内容"]')?.value
  ).toBe("External memory")
  await act(async () => button("保留草稿，采用最新版本").click())
  updateEntry.mockResolvedValueOnce({
    ...stored,
    entries: [{ ...stored.entries[0]!, content: "My draft", revision: "r3" }],
  })
  await act(async () => button("保存记忆").click())
  expect(updateEntry).toHaveBeenLastCalledWith({
    projectId: "project",
    id: "memory",
    content: "My draft",
    expectedRevision: "r2",
  })
})
it("does not delete a memory before the explicit confirmation", async () => {
  await selectProject()
  await act(async () => button("删除").click())
  expect(removeEntry).not.toHaveBeenCalled()
  removeEntry.mockResolvedValueOnce({ ...stored, entries: [] })
  await act(async () => button("确认").click())
  expect(removeEntry).toHaveBeenCalledWith({
    projectId: "project",
    id: "memory",
    expectedRevision: "r1",
  })
})
