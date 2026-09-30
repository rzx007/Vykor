import { DEFAULT_THEMES, type FileDiffOptions } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import { AlignJustify, Check, ChevronDown, Columns2, FileDiff, FileText } from "lucide-react"
import type * as React from "react"
import { Button } from "@renderer/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type { DesktopGitChangedFile, DesktopGitChangesResult, DesktopGitDiffScope, DesktopGitFileStatus } from "@shared/git-types"

export type DiffState = "idle" | "loading" | "ready" | "error"
export type DiffViewMode = "unified" | "split"
export type ReviewRange = "last-turn" | DesktopGitDiffScope

const reviewRangeOptions: Array<{ value: ReviewRange; label: string }> = [
  { value: "last-turn", label: "上一轮" },
  { value: "uncommitted", label: "未提交" },
  { value: "unstaged", label: "未暂存" },
  { value: "staged", label: "已暂存" },
]

const diffOptions: FileDiffOptions<undefined> = {
  collapsedContextThreshold: 6,
  disableFileHeader: true,
  hunkSeparators: "line-info-basic",
  lineDiffType: "word",
  overflow: "scroll",
  theme: DEFAULT_THEMES,
  tokenizeMaxLength: 220_000,
  tokenizeMaxLineLength: 20_000,
  unsafeCSS: `
    :host {
      display: block;
      min-width: max-content;
      background: transparent;
      color: var(--content-foreground);
      font-family: var(--font-mono);
      font-size: var(--code-font-size);
      line-height: var(--code-line-height);
    }

    pre {
      margin: 0;
      min-width: max-content;
      background: transparent !important;
      font-family: var(--font-mono) !important;
      font-size: var(--code-font-size) !important;
      line-height: var(--code-line-height) !important;
    }
  `,
}

export function DiffModeToggle({
  value,
  onChange,
}: {
  value: DiffViewMode
  onChange: (value: DiffViewMode) => void
}): React.JSX.Element {
  const nextValue = value === "unified" ? "split" : "unified"
  const Icon = value === "unified" ? Columns2 : AlignJustify
  const label = value === "unified" ? "切换到左右 diff" : "切换到统一 diff"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={value === "split"}
      onClick={() => onChange(nextValue)}
      className="text-muted-foreground"
    >
      <Icon />
    </Button>
  )
}

export function ReviewRangeSummary({
  changes,
  loading,
  value,
  onChange,
}: {
  changes: DesktopGitChangesResult | null
  loading: boolean
  value: ReviewRange
  onChange: (value: ReviewRange) => void
}): React.JSX.Element {
  const label = reviewRangeLabel(value)

  return (
    <div className="flex min-w-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="text-ui-small flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2 text-left font-medium text-ui-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          title={label}
        >
          <span className="truncate">{loading && !changes ? "正在读取改动" : label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {reviewRangeOptions.map((option) => (
            <DropdownMenuItem key={option.value} onClick={() => onChange(option.value)}>
              <span className="w-4 shrink-0">
                {option.value === value ? <Check className="size-3.5" /> : null}
              </span>
              <span>{option.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {changes ? (
        <span className="ml-2 inline-flex align-baseline font-mono text-xs font-semibold">
          <span className="text-emerald-600 dark:text-emerald-400">+{changes.totalAdditions}</span>
          <span className="ml-1 text-rose-600 dark:text-rose-400">-{changes.totalDeletions}</span>
        </span>
      ) : null}
    </div>
  )
}

export function ChangedFileStream({
  files,
  activePath,
  onSelect,
  diff,
}: {
  files: DesktopGitChangedFile[]
  activePath: string | null
  onSelect: (path: string) => void
  diff: React.ReactNode
}): React.JSX.Element {
  return (
    <ScrollArea className="min-h-0 flex-1 bg-background" viewportClassName="p-0">
      <div className="pb-3">
        {files.map((file) => {
          const active = file.path === activePath
          return (
            <section key={file.path} aria-label={file.path}>
              <button
                type="button"
                onClick={() => onSelect(file.path)}
                className={cn(
                  "flex h-10 w-full min-w-0 items-center gap-2 border-b border-border/35 px-3 text-left transition-colors",
                  active
                    ? "bg-background text-foreground"
                    : "bg-panel/55 text-ui-muted hover:bg-muted/65 hover:text-foreground"
                )}
                aria-expanded={active}
              >
                <FileText className="size-3.5 shrink-0 text-sky-500" strokeWidth={1.8} />
                <span className="text-ui-small min-w-0 flex-1 truncate" title={file.path}>
                  <PathWithFileName path={file.path} />
                </span>
                <StatusBadge status={file.status} />
                <LineStats file={file} />
              </button>
              {active ? diff : null}
            </section>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function PathWithFileName({ path }: { path: string }): React.JSX.Element {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (index < 0) return <span className="font-medium text-foreground">{path}</span>
  return (
    <>
      <span>{path.slice(0, index + 1)}</span>
      <span className="font-medium text-foreground">{path.slice(index + 1)}</span>
    </>
  )
}

export function InlineDiffPreview({
  file,
  patch,
  state,
  error,
  themeType,
  diffViewMode,
}: {
  file: DesktopGitChangedFile | null
  patch: string
  state: DiffState
  error: string | null
  themeType: "dark" | "light"
  diffViewMode: DiffViewMode
}): React.JSX.Element {
  return (
    <div className="border-b border-border/45 bg-background">
      <DiffPreviewContent
        file={file}
        patch={patch}
        state={state}
        error={error}
        themeType={themeType}
        diffViewMode={diffViewMode}
      />
    </div>
  )
}

function DiffPreviewContent({
  file,
  patch,
  state,
  error,
  themeType,
  diffViewMode,
}: {
  file: DesktopGitChangedFile | null
  patch: string
  state: DiffState
  error: string | null
  themeType: "dark" | "light"
  diffViewMode: DiffViewMode
}): React.JSX.Element {
  if (!file) {
    return (
      <InlineEmptyState icon={FileDiff} title="选择文件" description="点击文件查看对应 diff。" />
    )
  }

  if (state === "loading") {
    return (
      <div className="text-ui-small flex min-h-40 items-center justify-center gap-2 text-ui-muted">
        <Spinner />
        正在读取 diff...
      </div>
    )
  }

  if (state === "error") {
    return (
      <InlineEmptyState
        icon={FileDiff}
        title="无法读取文件 diff"
        description={error ?? "请稍后重试。"}
      />
    )
  }

  if (file.binary) {
    return (
      <InlineEmptyState
        icon={FileDiff}
        title="二进制文件"
        description="这类改动暂不展示文本 diff。"
      />
    )
  }

  if (!patch.startsWith("diff --git")) {
    return (
      <InlineEmptyState
        icon={FileDiff}
        title="没有可展示的文本 diff"
        description="该文件没有文本差异。"
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <PatchDiff
        key={`${file.path}:${patch.length}:${themeType}:${diffViewMode}`}
        patch={patch}
        options={{ ...diffOptions, diffStyle: diffViewMode, themeType }}
        className="desktop-review-diff min-w-max"
      />
    </div>
  )
}

function InlineEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-40 items-center justify-center px-4 py-8 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Icon className="size-5 text-muted-foreground" />
        <div className="text-ui-small font-medium text-foreground">{title}</div>
        <p className="text-xs leading-5 text-ui-muted">{description}</p>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: DesktopGitFileStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        "text-ui-caption inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border font-semibold",
        status === "added" || status === "untracked"
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : status === "deleted"
            ? "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            : status === "renamed" || status === "copied"
              ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
              : "border-border bg-muted text-muted-foreground"
      )}
      title={statusLabel(status)}
    >
      {statusShortLabel(status)}
    </span>
  )
}

function LineStats({ file }: { file: DesktopGitChangedFile }): React.JSX.Element {
  if (file.binary) {
    return <span className="text-ui-caption shrink-0 font-mono text-ui-muted">bin</span>
  }

  if (file.additions === null && file.deletions === null) {
    return <span className="text-ui-caption shrink-0 font-mono text-ui-muted">--</span>
  }

  return (
    <span className="text-ui-caption shrink-0 font-mono font-semibold tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{file.additions ?? 0}</span>
      <span className="ml-1 text-rose-600 dark:text-rose-400">-{file.deletions ?? 0}</span>
    </span>
  )
}

function statusShortLabel(status: DesktopGitFileStatus): string {
  switch (status) {
    case "added":
      return "A"
    case "deleted":
      return "D"
    case "renamed":
      return "R"
    case "copied":
      return "C"
    case "untracked":
      return "?"
    case "modified":
      return "M"
  }
}

function statusLabel(status: DesktopGitFileStatus): string {
  switch (status) {
    case "added":
      return "新增"
    case "deleted":
      return "删除"
    case "renamed":
      return "重命名"
    case "copied":
      return "复制"
    case "untracked":
      return "未跟踪"
    case "modified":
      return "修改"
  }
}

function reviewRangeLabel(value: ReviewRange): string {
  return reviewRangeOptions.find((option) => option.value === value)?.label ?? value
}
