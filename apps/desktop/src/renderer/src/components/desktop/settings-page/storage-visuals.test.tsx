// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageReport } from "@shared/maintenance-settings-types"
import { StorageRestoreSteps, StorageSpaceOverview } from "./storage-visuals"
const report: StorageReport = {
  scannedAt: 1,
  dataDirectory: "D:/data",
  totalBytes: 1024,
  availableBytes: 4096,
  writable: true,
  categories: [
    {
      id: "database",
      name: "会话数据库",
      bytes: 256,
      files: 1,
      paths: ["D:/data/sessions.db"],
      errors: [],
    },
    {
      id: "attachments",
      name: "附件",
      bytes: 768,
      files: 3,
      paths: ["D:/data/attachments"],
      errors: [],
    },
    { id: "logs", name: "日志", bytes: 0, files: 0, paths: ["D:/data/logs"], errors: [] },
  ],
}
describe("storage visual facts", () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  it("draws actual category proportions and keeps directory details collapsed", async () => {
    await act(async () => root.render(<StorageSpaceOverview report={report} />))
    expect(
      [...container.querySelectorAll('svg[role="img"] rect')].map((rect) =>
        rect.getAttribute("width")
      )
    ).toEqual(["100", "25", "75"])
    expect(container.textContent).toContain("25.0%")
    expect(container.textContent).toContain("75.0%")
    expect([...container.querySelectorAll("details")].every((details) => !details.open)).toBe(true)
    expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain(
      "会话数据库"
    )
  })
  it("does not invent disk capacity or complete scans when facts are missing", async () => {
    await act(async () =>
      root.render(
        <StorageSpaceOverview
          report={{
            ...report,
            availableBytes: null,
            categories: [{ ...report.categories[0]!, errors: ["目录不可访问"] }],
          }}
        />
      )
    )
    expect(container.textContent).toContain("未知")
    expect(container.textContent).toContain("部分统计")
    expect(container.textContent).toContain("已知占用")
  })
  it("handles empty storage without invalid chart dimensions", async () => {
    await act(async () =>
      root.render(
        <StorageSpaceOverview
          report={{
            ...report,
            totalBytes: 0,
            categories: report.categories.map((item) => ({ ...item, bytes: 0, files: 0 })),
          }}
        />
      )
    )
    expect(container.querySelectorAll('svg[role="img"] rect')).toHaveLength(1)
    expect(container.textContent).not.toMatch(/NaN|Infinity/)
  })
  it("shows only completed restore steps as ready", async () => {
    await act(async () =>
      root.render(<StorageRestoreSteps source="backup" target="" restored="" />)
    )
    expect(container.textContent).toContain("备份已校验")
    expect(container.textContent).toContain("选择空目录")
    expect(container.textContent).not.toContain("恢复数据就绪")
  })
})
