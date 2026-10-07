import { FileDiff, GitPullRequestDraft, RefreshCw } from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { collectChangedFiles } from "@renderer/components/desktop/conversation-page/message/message-render-model"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { queryGitChanges } from "@renderer/lib/git-changes-query"
import { cn } from "@renderer/lib/utils"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type {
  DesktopGitChangesResult,
  DesktopGitDiffScope,
  DesktopGitReviewRequest,
} from "@shared/git-types"
import type { DesktopSessionView } from "@shared/session-types"
import { toProjectRelativePath } from "@shared/workspace-open-path"
import {
  ChangedFileStream,
  DiffModeToggle,
  InlineDiffPreview,
  ReviewRangeSummary,
  type DiffState,
  type DiffViewMode,
  type ReviewRange,
} from "./review-tool-view"

type LoadState = "idle" | "loading" | "ready" | "error"
export function ReviewTool({
  openRequest,
}: {
  openRequest?: DesktopGitReviewRequest | null
}): React.JSX.Element {
  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const selectedProjectPath = openRequest?.rootPath ?? selectedProject?.path
  const [loadState, setLoadState] = useState<LoadState>("idle")
  const [diffState, setDiffState] = useState<DiffState>("idle")
  const [reviewRange, setReviewRange] = useState<ReviewRange>(openRequest?.scope ?? "uncommitted")
  const [changes, setChanges] = useState<DesktopGitChangesResult | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [patch, setPatch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified")
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const { resolvedTheme: themeType } = useAppearance()
  const handledOpenRequestRef = useRef<number | null>(null)
  const changesRequestVersionRef = useRef(0)
  const lastTurnFilePaths = useMemo(() => collectLastTurnFilePaths(sessionView), [sessionView])

  useEffect(() => {
    let cancelled = false
    if (!window.desktop.gitSettings) return
    void window.desktop.gitSettings
      .readPreferences()
      .then((preferences) => {
        if (cancelled) return
        if (!openRequest?.scope) setReviewRange(preferences.defaultScope)
        setDiffViewMode(preferences.viewMode)
        setIgnoreWhitespace(preferences.ignoreWhitespace)
        setPreferenceError(null)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setPreferenceError(errorMessage(failure))
      })
    return () => {
      cancelled = true
    }
  }, [openRequest?.id, openRequest?.scope])

  const loadChanges = useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
      const requestVersion = ++changesRequestVersionRef.current
      if (!selectedProjectPath) {
        setChanges(null)
        setLoadState("idle")
        return
      }

      setLoadState("loading")
      setError(null)
      try {
        const result = await queryGitChanges(
          {
            rootPath: selectedProjectPath,
            scope: gitScopeForRange(reviewRange),
            ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
          },
          { force }
        )
        if (requestVersion !== changesRequestVersionRef.current) return
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
        if (requestVersion !== changesRequestVersionRef.current) return
        setError(errorMessage(loadError))
        setLoadState("error")
      }
    },
    [ignoreWhitespace, lastTurnFilePaths, reviewRange, selectedProjectPath]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadChanges()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      // This is a request counter, not a DOM ref; cleanup must invalidate the latest request.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      changesRequestVersionRef.current++
    }
  }, [loadChanges])

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest.id) return
    const path = openRequest.path
      ? toProjectRelativePath(openRequest.path, selectedProjectPath)
      : null
    if (openRequest.path && !path) return
    const timer = window.setTimeout(() => {
      handledOpenRequestRef.current = openRequest.id
      if (path) setActivePath(path)
      if (openRequest.scope && openRequest.scope !== reviewRange) {
        setReviewRange(openRequest.scope)
        return
      }
      if (!changes?.files.length || (path && !changes.files.some((file) => file.path === path))) {
        void loadChanges()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [changes?.files, loadChanges, openRequest, reviewRange, selectedProjectPath])

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
          ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
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
  }, [activeFile?.status, activePath, ignoreWhitespace, reviewRange, selectedProjectPath])

  if (!selectedProjectPath) {
    return (
      <DesktopEmptyState
        icon={GitPullRequestDraft}
        size="sm"
        title="审阅改动"
        description="当前工作目录不可用。"
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      {preferenceError && (
        <p className="px-3 py-1 text-xs text-destructive">
          Git 显示偏好读取失败，保留当前显示选择：{preferenceError}
        </p>
      )}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-3">
        {openRequest?.rootPath ? (
          <span className="text-xs text-ui-muted" title={selectedProjectPath}>
            当前工作区差异
          </span>
        ) : null}
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
          onClick={() => void loadChanges({ force: true })}
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
