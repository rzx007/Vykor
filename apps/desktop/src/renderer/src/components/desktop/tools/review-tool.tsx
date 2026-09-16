import { DEFAULT_THEMES, type FileDiffOptions } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import {
  AlignJustify,
  Check,
  ChevronDown,
  Columns2,
  FileDiff,
  FileText,
  GitPullRequestDraft,
  RefreshCw,
} from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { collectChangedFiles } from "@renderer/components/desktop/conversation-page/message/message-render-model"
import { Button } from "@renderer/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  DesktopGitChangedFile,
  DesktopGitChangesResult,
  DesktopGitDiffScope,
  DesktopGitFileStatus,
} from "@shared/git-types"
import type { DesktopSessionView } from "@shared/session-types"
import { toProjectRelativePath } from "@shared/workspace-open-path"

type LoadState = "idle" | "loading" | "ready" | "error"
type DiffState = "idle" | "loading" | "ready" | "error"
type DiffViewMode = "unified" | "split"
type ReviewRange = "last-turn" | DesktopGitDiffScope

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

export function ReviewTool({
  openRequest,
}: {
  openRequest?: { id: number; path?: string } | null
}): React.JSX.Element {
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const selectedProjectPath = selectedProject?.path
  const [loadState, setLoadState] = useState<LoadState>("idle")
  const [diffState, setDiffState] = useState<DiffState>("idle")
  const [reviewRange, setReviewRange] = useState<ReviewRange>("last-turn")
  const [changes, setChanges] = useState<DesktopGitChangesResult | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [patch, setPatch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified")
  const { resolvedTheme: themeType } = useAppearance()
  const handledOpenRequestRef = useRef<number | null>(null)
  const lastTurnFilePaths = useMemo(() => collectLastTurnFilePaths(sessionView), [sessionView])

  const loadChanges = useCallback(async (): Promise<void> => {
    if (!selectedProjectPath) {
      setChanges(null)
      setLoadState("idle")
      return
    }

    setLoadState("loading")
    setError(null)
    try {
      const result = await window.desktop.git.changes({
        rootPath: selectedProjectPath,
        scope: gitScopeForRange(reviewRange),
      })
      const visibleResult =
        reviewRange === "last-turn"
          ? filterChangesByPaths(result, lastTurnFilePaths, selectedProjectPath)
          : result
      setChanges(visibleResult)
      setActivePath((current) =>
        current && visibleResult.files.some((file) => file.path === current)
          ? current
          : (visibleResult.files[0]?.path ?? null)
      )
      setLoadState("ready")
    } catch (loadError) {
      setError(errorMessage(loadError))
      setLoadState("error")
    }
  }, [lastTurnFilePaths, reviewRange, selectedProjectPath])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadChanges()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadChanges])

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest.id) return
    handledOpenRequestRef.current = openRequest.id
    const path = openRequest.path
      ? toProjectRelativePath(openRequest.path, selectedProjectPath)
      : null
    if (openRequest.path && !path) return
    const timer = window.setTimeout(() => {
      if (path) setActivePath(path)
      if (!changes?.files.length || (path && !changes.files.some((file) => file.path === path))) {
        void loadChanges()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [changes?.files, loadChanges, openRequest, selectedProjectPath])

  const activeFile = changes?.files.find((file) => file.path === activePath) ?? null

  useEffect(() => {
    if (!selectedProjectPath || !activePath) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setDiffState("loading")
      setDiffError(null)
      void window.desktop.git
        .fileDiff({
          rootPath: selectedProjectPath,
          path: activePath,
          status: activeFile?.status,
          scope: gitScopeForRange(reviewRange),
        })
        .then((result) => {
          if (cancelled) return
          setPatch(result.patch)
          setDiffState("ready")
        })
        .catch((loadError: unknown) => {
          if (cancelled) return
          setPatch("")
          setDiffError(errorMessage(loadError))
          setDiffState("error")
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeFile?.status, activePath, reviewRange, selectedProjectPath])

  if (!selectedProject) {
    return (
      <DesktopEmptyState
        icon={GitPullRequestDraft}
        size="sm"
        title="审阅改动"
        description="选择一个项目后可以查看文件 diff。"
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-3">
        <div className="min-w-0 flex-1">
          <ReviewRangeSummary
            changes={changes}
            loading={loadState === "loading"}
            value={reviewRange}
            onChange={setReviewRange}
          />
        </div>
        <DiffModeToggle value={diffViewMode} onChange={setDiffViewMode} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="刷新改动"
          title="刷新改动"
          onClick={() => void loadChanges()}
          className="text-muted-foreground"
        >
          <RefreshCw className={cn(loadState === "loading" && "animate-spin")} />
        </Button>
      </div>

      {loadState === "loading" && !changes && (
        <div className="text-ui-small flex flex-1 items-center justify-center gap-2 text-ui-muted">
          <Spinner />
          正在读取改动...
        </div>
      )}

      {loadState === "error" && (
        <DesktopEmptyState
          icon={FileDiff}
          size="sm"
          title="无法读取 Git 改动"
          description={error ?? "请稍后重试。"}
        />
      )}

      {loadState === "ready" && changes?.files.length === 0 && (
        <DesktopEmptyState
          icon={GitPullRequestDraft}
          size="sm"
          title="没有待审阅改动"
          description="当前项目相对 HEAD 没有文件变化。"
        />
      )}

      {changes && changes.files.length > 0 && (
        <ChangedFileStream
          files={changes.files}
          activePath={activePath}
          onSelect={setActivePath}
          diff={
            <InlineDiffPreview
              file={changes.files.find((file) => file.path === activePath) ?? null}
              patch={patch}
              state={diffState}
              error={diffError}
              themeType={themeType}
              diffViewMode={diffViewMode}
            />
          }
        />
      )}
    </section>
  )
}

function DiffModeToggle({
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

function ReviewRangeSummary({
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

function ChangedFileStream({
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

function InlineDiffPreview({
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

function gitScopeForRange(value: ReviewRange): DesktopGitDiffScope {
  return value === "staged" || value === "unstaged" ? value : "uncommitted"
}

function filterChangesByPaths(
  changes: DesktopGitChangesResult,
  paths: readonly string[],
  projectPath: string | undefined
): DesktopGitChangesResult {
  if (paths.length === 0) {
    return { ...changes, files: [], totalAdditions: 0, totalDeletions: 0 }
  }

  const pathSet = new Set(
    paths
      .map((path) => toProjectRelativePath(path, projectPath))
      .filter((path): path is string => Boolean(path))
      .map(normalizeReviewPath)
  )
  const files = changes.files.filter((file) => {
    if (pathSet.has(normalizeReviewPath(file.path))) return true
    return file.oldPath ? pathSet.has(normalizeReviewPath(file.oldPath)) : false
  })
  return {
    ...changes,
    files,
    totalAdditions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    totalDeletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  }
}

function collectLastTurnFilePaths(view: DesktopSessionView | null): string[] {
  if (!view) return []

  const messages = [...view.messages]
    .filter((message) => message.role === "assistant")
    .sort((left, right) => right.seq - left.seq)

  for (const message of messages) {
    const messageParts = view.parts.filter((part) => part.messageId === message.id)
    if (messageParts.some((part) => part.status === "pending" || part.status === "running")) {
      continue
    }
    const changedFiles = collectChangedFiles(messageParts)
    if (changedFiles.length > 0) {
      return changedFiles.map((file) => file.path)
    }
  }

  return []
}

function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}
