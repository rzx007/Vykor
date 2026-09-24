import { describe, expect, it } from "vitest"

import type { AttachmentStorageIssue, AttachmentStorageReport } from "@vykor/client"
import {
  canCollectStorage,
  canRepairStorage,
  formatBytes,
  groupStorageIssues,
  storageComposition,
  totalAssets,
} from "./attachment-storage-format"

describe("attachment storage display helpers", () => {
  it("formats byte values without leaking invalid numbers into the UI", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB")
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 GB")
    expect(formatBytes(-1)).toBe("0 B")
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B")
  })

  it("adds all asset states instead of hiding failed or deleted records", () => {
    expect(totalAssets(report().summary.assets)).toBe(14)
  })

  it("builds a truthful storage composition and clamps inconsistent reports", () => {
    expect(storageComposition(100, 25)).toEqual({
      retainedBytes: 75,
      retainedPercent: 75,
      reclaimableBytes: 25,
      reclaimablePercent: 25,
    })
    expect(storageComposition(100, 150)).toEqual({
      retainedBytes: 0,
      retainedPercent: 0,
      reclaimableBytes: 100,
      reclaimablePercent: 100,
    })
    expect(storageComposition(0, 10)).toEqual({
      retainedBytes: 0,
      retainedPercent: 0,
      reclaimableBytes: 0,
      reclaimablePercent: 0,
    })
    expect(storageComposition(Number.NaN, -10)).toEqual({
      retainedBytes: 0,
      retainedPercent: 0,
      reclaimableBytes: 0,
      reclaimablePercent: 0,
    })
  })

  it("groups repeated issues while preserving the strongest severity", () => {
    const grouped = groupStorageIssues([
      issue("stale_lease", "warning"),
      issue("stale_lease", "error"),
      issue("missing_blob", "error"),
    ])

    expect(grouped).toEqual([
      { code: "missing_blob", severity: "error", count: 1 },
      { code: "stale_lease", severity: "error", count: 2 },
    ])
  })

  it("enables only maintenance actions supported by the report", () => {
    expect(canRepairStorage(report({ issues: [issue("stale_lease")] }))).toBe(true)
    expect(canRepairStorage(report({ issues: [issue("size_mismatch", "error")] }))).toBe(false)
    expect(canCollectStorage(report({ reclaimableBytes: 10 }))).toBe(true)
    expect(
      canCollectStorage(report({ issues: [issue("deleted_asset_retained")], reclaimableBytes: 0 }))
    ).toBe(true)
    expect(canCollectStorage(report())).toBe(false)
  })
})

function issue(
  code: AttachmentStorageIssue["code"],
  severity: AttachmentStorageIssue["severity"] = "warning"
): AttachmentStorageIssue {
  return { code, severity }
}

function report(
  overrides: {
    issues?: AttachmentStorageIssue[]
    reclaimableBytes?: number
  } = {}
): AttachmentStorageReport {
  return {
    summary: {
      assets: { importing: 1, ready: 10, failed: 2, deleted: 1 },
      uniqueBlobs: 9,
      physicalBytes: 1024,
      logicalBytes: 2048,
      deduplicatedBytes: 1024,
      activeLeases: 0,
      expiredLeases: 0,
      reclaimableBytes: overrides.reclaimableBytes ?? 0,
    },
    issues: overrides.issues ?? [],
  }
}
