// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AttachmentStorageGcResult,
  AttachmentStorageIssue,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@vykor/client"
import { AttachmentStorageSettings } from "./attachment-storage-settings"

describe("AttachmentStorageSettings", () => {
  let container: HTMLDivElement
  let root: Root
  let scanStorage: ReturnType<typeof vi.fn>
  let repairStorage: ReturnType<typeof vi.fn>
  let gcStorage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    scanStorage = vi.fn(async () => storageReport())
    repairStorage = vi.fn(async () => repairResult)
    gcStorage = vi.fn(async () => gcResult)
    setAttachmentApi({ scanStorage, repairStorage, gcStorage })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("scans on mount and renders source-of-truth storage statistics", async () => {
    await renderPage()

    expect(scanStorage).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("2 GB")
    expect(container.textContent).toContain("14")
    expect(container.textContent).toContain("512 MB")
    expect(container.textContent).toContain("128 MB")
    expect(container.textContent).toContain("存储正常")
  })

  it("visualizes retained and reclaimable storage without treating dedup savings as occupied space", async () => {
    await renderPage(storageReport({ physicalBytes: 100, reclaimableBytes: 25 }))

    expect(container.textContent).toContain("当前保留")
    expect(container.textContent).toContain("去重节省")
    expect(container.textContent).toContain("可清理")
    expect(
      container.querySelector(
        '[aria-label="实际占用由当前保留 75% 和可清理 25% 组成；去重节省不计入实际占用"]'
      )
    ).not.toBeNull()
    expect(container.textContent).toContain("附件总数")
    expect(container.textContent).toContain("唯一文件")
    expect(container.textContent).toContain("正在使用")
    expect(container.textContent).toContain("正在导入")
    expect(container.textContent).toContain("处理失败")
  })

  it("shows an initial scan error and retries without crashing the settings page", async () => {
    scanStorage
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(storageReport())

    await renderPage()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("daemon unavailable")

    await clickButton("重试")

    expect(scanStorage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("存储正常")
  })

  it("runs safe repair once, reports its result, and refreshes the scan", async () => {
    scanStorage
      .mockResolvedValueOnce(storageReport({ issues: [issue("stale_lease")] }))
      .mockResolvedValueOnce(storageReport())

    await renderPage()
    await clickButton("安全修复")

    expect(repairStorage).toHaveBeenCalledTimes(1)
    expect(scanStorage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("已清除 1 个过期占用")
    expect(container.textContent).toContain("释放 64 MB")
  })

  it("does not report a completed repair as failed when only the follow-up scan fails", async () => {
    scanStorage
      .mockResolvedValueOnce(storageReport({ issues: [issue("stale_lease")] }))
      .mockRejectedValueOnce(new Error("refresh unavailable"))

    await renderPage()
    await clickButton("安全修复")

    expect(repairStorage).toHaveBeenCalledTimes(1)
    expect(scanStorage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("安全修复完成，状态刷新失败")
    expect(container.textContent).toContain("refresh unavailable")
    expect(container.textContent).not.toContain("安全修复失败")
  })

  it("requires explicit confirmation before garbage collection", async () => {
    await renderPage(storageReport({ reclaimableBytes: 128 * 1024 * 1024 }))

    await clickButton("清理 128 MB")
    expect(gcStorage).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("确认清理无用附件？")

    await clickButton("取消", document)
    expect(gcStorage).not.toHaveBeenCalled()

    await clickButton("清理 128 MB")
    await clickButton("确认清理", document)

    expect(gcStorage).toHaveBeenCalledTimes(1)
    expect(scanStorage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("已删除 2 个附件")
    expect(container.textContent).toContain("释放 128 MB")
  })

  it("does not report completed garbage collection as failed when only the follow-up scan fails", async () => {
    scanStorage
      .mockResolvedValueOnce(storageReport({ reclaimableBytes: 128 * 1024 * 1024 }))
      .mockRejectedValueOnce(new Error("refresh unavailable"))

    await renderPage()
    await clickButton("清理 128 MB")
    await clickButton("确认清理", document)

    expect(gcStorage).toHaveBeenCalledTimes(1)
    expect(scanStorage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("附件清理完成，状态刷新失败")
    expect(container.textContent).toContain("refresh unavailable")
    expect(container.textContent).not.toContain("附件清理失败")
  })

  it("renders an unsupported state when the Desktop diagnostics API is missing", async () => {
    setAttachmentApi(undefined)

    await renderPage()

    expect(container.textContent).toContain("当前环境不支持附件存储诊断")
  })

  async function renderPage(initialReport?: AttachmentStorageReport): Promise<void> {
    if (initialReport) scanStorage.mockResolvedValue(initialReport)
    await act(async () => root.render(createElement(AttachmentStorageSettings)))
  }

  async function clickButton(label: string, scope: ParentNode = container): Promise<void> {
    const button = [...scope.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label)
    )
    expect(button, `button containing ${label}`).toBeDefined()
    await act(async () => button?.click())
  }
})

function setAttachmentApi(
  attachments:
    | {
        scanStorage: () => Promise<AttachmentStorageReport>
        repairStorage: () => Promise<AttachmentStorageRepairResult>
        gcStorage: () => Promise<AttachmentStorageGcResult>
      }
    | undefined
): void {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: attachments ? { attachments } : {},
  })
}

function issue(
  code: AttachmentStorageIssue["code"],
  severity: AttachmentStorageIssue["severity"] = "warning"
): AttachmentStorageIssue {
  return { code, severity }
}

function storageReport(
  overrides: {
    issues?: AttachmentStorageIssue[]
    physicalBytes?: number
    reclaimableBytes?: number
  } = {}
): AttachmentStorageReport {
  return {
    summary: {
      assets: { importing: 1, ready: 10, failed: 2, deleted: 1 },
      uniqueBlobs: 9,
      physicalBytes: overrides.physicalBytes ?? 2 * 1024 * 1024 * 1024,
      logicalBytes: 2.5 * 1024 * 1024 * 1024,
      deduplicatedBytes: 512 * 1024 * 1024,
      activeLeases: 3,
      expiredLeases: 0,
      reclaimableBytes: overrides.reclaimableBytes ?? 128 * 1024 * 1024,
    },
    issues: overrides.issues ?? [],
  }
}

const repairResult: AttachmentStorageRepairResult = {
  expiredLeases: 1,
  deletedOrphanBlobs: 2,
  releasedBytes: 64 * 1024 * 1024,
}

const gcResult: AttachmentStorageGcResult = {
  scannedAssets: 14,
  expiredLeases: 0,
  deletedAssets: 2,
  deletedBlobs: 2,
  releasedBytes: 128 * 1024 * 1024,
  skipped: {
    notDeleted: 10,
    gracePeriod: 0,
    missingHash: 0,
    referenced: 1,
    activeLease: 1,
    sharedBlob: 0,
  },
  errors: [],
}
