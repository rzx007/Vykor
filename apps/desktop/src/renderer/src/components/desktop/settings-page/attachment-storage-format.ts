import type { AttachmentStorageIssue, AttachmentStorageReport } from "@vykor/client"

export type GroupedStorageIssue = Pick<AttachmentStorageIssue, "code" | "severity"> & {
  count: number
}

export type StorageComposition = {
  retainedBytes: number
  retainedPercent: number
  reclaimableBytes: number
  reclaimablePercent: number
}

const ISSUE_ORDER: AttachmentStorageIssue["code"][] = [
  "missing_blob",
  "size_mismatch",
  "orphan_blob",
  "stale_lease",
  "deleted_asset_retained",
]

const REPAIRABLE_ISSUES = new Set<AttachmentStorageIssue["code"]>(["orphan_blob", "stale_lease"])

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB"] as const
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** unitIndex
  const rounded =
    scaled >= 10 || Number.isInteger(scaled) ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${rounded} ${units[unitIndex]}`
}

export function totalAssets(assets: AttachmentStorageReport["summary"]["assets"]): number {
  return assets.importing + assets.ready + assets.failed + assets.deleted
}

export function storageComposition(
  physicalBytes: number,
  reclaimableBytes: number
): StorageComposition {
  const physical = Number.isFinite(physicalBytes) && physicalBytes > 0 ? physicalBytes : 0
  if (physical === 0) {
    return {
      retainedBytes: 0,
      retainedPercent: 0,
      reclaimableBytes: 0,
      reclaimablePercent: 0,
    }
  }

  const reclaimable =
    Number.isFinite(reclaimableBytes) && reclaimableBytes > 0
      ? Math.min(reclaimableBytes, physical)
      : 0
  const reclaimablePercent = (reclaimable / physical) * 100

  return {
    retainedBytes: physical - reclaimable,
    retainedPercent: 100 - reclaimablePercent,
    reclaimableBytes: reclaimable,
    reclaimablePercent,
  }
}

export function groupStorageIssues(
  issues: readonly AttachmentStorageIssue[]
): GroupedStorageIssue[] {
  const grouped = new Map<AttachmentStorageIssue["code"], GroupedStorageIssue>()

  for (const issue of issues) {
    const current = grouped.get(issue.code)
    grouped.set(issue.code, {
      code: issue.code,
      count: (current?.count ?? 0) + 1,
      severity: current?.severity === "error" || issue.severity === "error" ? "error" : "warning",
    })
  }

  return ISSUE_ORDER.flatMap((code) => {
    const issue = grouped.get(code)
    return issue ? [issue] : []
  })
}

export function canRepairStorage(report: AttachmentStorageReport): boolean {
  return report.issues.some((issue) => REPAIRABLE_ISSUES.has(issue.code))
}

export function canCollectStorage(report: AttachmentStorageReport): boolean {
  return (
    report.summary.reclaimableBytes > 0 ||
    report.issues.some((issue) => issue.code === "deleted_asset_retained")
  )
}
