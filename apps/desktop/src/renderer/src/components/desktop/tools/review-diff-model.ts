import {
  getSingularPatch,
  type FileDiffMetadata,
  type SelectedLineRange,
  type SelectionSide,
} from "@pierre/diffs"

export interface ReviewDiffRow {
  oldLine?: number
  newLine?: number
  text: string
  kind: "context" | "deletion" | "addition"
  hunkIndex: number
}
export interface ReviewDiffTarget {
  line: number
  side: SelectionSide
  rowIndex: number
  column?: number
}
export interface ReviewDiffModel {
  fileDiff: FileDiffMetadata
  rows: ReviewDiffRow[]
  changes: ReviewDiffTarget[]
}
export interface ReviewSelectionSource {
  rootPath: string
  path: string
  oldPath?: string
  range: "last-turn" | "uncommitted" | "unstaged" | "staged"
}

export function createReviewDiffModel(patch: string): ReviewDiffModel | null {
  if (!patch.startsWith("diff --git")) return null
  try {
    const fileDiff = getSingularPatch(patch)
    const rows: ReviewDiffRow[] = []
    const changes: ReviewDiffTarget[] = []
    fileDiff.hunks.forEach((hunk, hunkIndex) => {
      for (const part of hunk.hunkContent) {
        const oldStart = hunk.deletionStart + part.deletionLineIndex - hunk.deletionLineIndex
        const newStart = hunk.additionStart + part.additionLineIndex - hunk.additionLineIndex
        if (part.type === "context") {
          for (let i = 0; i < part.lines; i++)
            rows.push({
              oldLine: oldStart + i,
              newLine: newStart + i,
              text: fileDiff.additionLines[part.additionLineIndex + i] ?? "",
              kind: "context",
              hunkIndex,
            })
        } else {
          const rowIndex = rows.length
          for (let i = 0; i < part.deletions; i++)
            rows.push({
              oldLine: oldStart + i,
              text: fileDiff.deletionLines[part.deletionLineIndex + i] ?? "",
              kind: "deletion",
              hunkIndex,
            })
          for (let i = 0; i < part.additions; i++)
            rows.push({
              newLine: newStart + i,
              text: fileDiff.additionLines[part.additionLineIndex + i] ?? "",
              kind: "addition",
              hunkIndex,
            })
          if (part.additions || part.deletions)
            changes.push({
              line: part.additions ? newStart : oldStart,
              side: part.additions ? "additions" : "deletions",
              rowIndex: rowIndex + (part.additions ? part.deletions : 0),
            })
        }
      }
    })
    return { fileDiff, rows, changes }
  } catch {
    return null
  }
}

export function reviewRowLine(row: ReviewDiffRow, side: SelectionSide): number | undefined {
  return side === "deletions" ? row.oldLine : row.newLine
}

export function reviewSelectionText(
  model: ReviewDiffModel,
  range: SelectedLineRange,
  source: ReviewSelectionSource
): string {
  const side = range.side ?? "additions",
    endSide = range.endSide ?? side
  const start = model.rows.findIndex((row) => reviewRowLine(row, side) === range.start)
  const end = model.rows.findIndex((row) => reviewRowLine(row, endSide) === range.end)
  if (start < 0 || end < 0) throw new Error("选区已变化，请重新选择。")
  const first = Math.min(start, end),
    last = Math.max(start, end)
  const chunks: string[] = []
  let hunkIndex = -1
  for (let i = Math.max(0, first - 3); i <= Math.min(model.rows.length - 1, last + 3); i++) {
    const row = model.rows[i]!
    if (row.hunkIndex < model.rows[first]!.hunkIndex || row.hunkIndex > model.rows[last]!.hunkIndex)
      continue
    if (row.hunkIndex !== hunkIndex) {
      hunkIndex = row.hunkIndex
      chunks.push(model.fileDiff.hunks[hunkIndex]!.hunkSpecs?.trimEnd() ?? "@@")
    }
    chunks.push(
      `${row.kind === "deletion" ? "-" : row.kind === "addition" ? "+" : " "}${row.text.replace(/\r?\n$/, "")}`
    )
    const hunk = model.fileDiff.hunks[row.hunkIndex]!
    if (
      (hunk.noEOFCRDeletions && row.oldLine === hunk.deletionStart + hunk.deletionCount - 1) ||
      (hunk.noEOFCRAdditions && row.newLine === hunk.additionStart + hunk.additionCount - 1)
    )
      chunks.push("\\ No newline at end of file")
  }
  const oldPath = source.oldPath ?? model.fileDiff.prevName ?? source.path
  const selectedPath = side === "deletions" && endSide === side ? oldPath : source.path
  const version = (value: SelectionSide) => (value === "deletions" ? "旧版" : "新版")
  const selected =
    side === endSide
      ? `${version(side)} ${Math.min(range.start, range.end)}–${Math.max(range.start, range.end)}`
      : `${version(side)} ${range.start} → ${version(endSide)} ${range.end}`
  const labels = {
    "last-turn": "上一轮（当前未提交）",
    uncommitted: "未提交",
    unstaged: "未暂存",
    staged: "已暂存",
  }
  const excerpt = chunks.join("\n")
  let ticks = 3
  for (const match of excerpt.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1)
  const fence = "`".repeat(ticks)
  return `\n\n项目：${source.rootPath}\n文件：${selectedPath}:${range.start}${oldPath !== source.path ? `（${oldPath} → ${source.path}）` : ""}\n审阅：${labels[source.range]} · ${selected}\n${fence}diff\n${excerpt}\n${fence}\n`
}

export function findReviewMatches(
  model: ReviewDiffModel | null,
  query: string
): ReviewDiffTarget[] {
  if (!model || !query) return []
  const needle = query.toLocaleLowerCase(),
    matches: ReviewDiffTarget[] = []
  for (const [rowIndex, row] of model.rows.entries()) {
    const text = row.text.toLocaleLowerCase()
    for (
      let column = text.indexOf(needle);
      column !== -1;
      column = text.indexOf(needle, column + needle.length)
    ) {
      matches.push({
        rowIndex,
        side: row.newLine !== undefined ? "additions" : "deletions",
        line: row.newLine ?? row.oldLine!,
        column,
      })
      if (matches.length >= 5000) return matches
    }
  }
  return matches
}

export function stepReviewIndex(current: number, direction: -1 | 1, count: number): number {
  return count === 0
    ? -1
    : current < 0
      ? direction === 1
        ? 0
        : count - 1
      : (current + direction + count) % count
}
