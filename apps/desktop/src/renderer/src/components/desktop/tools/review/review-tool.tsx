import { FileDiff, GitPullRequestDraft, RefreshCw } from "lucide-react"
import type * as React from "react"
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { DesktopEmptyState } from "@renderer/components/desktop/shared/desktop-empty-state"
import { collectChangedFiles } from "@renderer/components/desktop/conversation-page/message/models/message-render-model"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { queryGitChanges } from "@renderer/lib/git-changes-query"
import { cn } from "@renderer/lib/utils"
import { toast } from "@renderer/lib/toast"
import { MainLayoutContext } from "@renderer/components/desktop/layout/main-layout/main-layout-context"
import {
  revalidateReviewedFiles,
  reviewFileKey,
  reviewPatchFingerprint,
  useReviewedFiles,
} from "./reviewed-files"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type {
  DesktopGitChangesResult,
  DesktopGitChangedFile,
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
  scopeId: providedScopeId,
}: {
  openRequest?: DesktopGitReviewRequest | null
  scopeId?: string
}): React.JSX.Element {
  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const layout = useContext(MainLayoutContext)
  const scopeId =
    providedScopeId ?? (activeSessionId ? `session:${activeSessionId}` : "draft:review")
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const selectedProjectPath = openRequest?.rootPath ?? selectedProject?.path
  const [loadState, setLoadState] = useState<LoadState>("idle")
  const [diff, setDiff] = useState<{
    key: string
    state: DiffState
    patch: string
    error: string | null
    refreshing: boolean
    fingerprint?: string
  }>({ key: "", state: "idle", patch: "", error: null, refreshing: false })
  const [patchRevision, setPatchRevision] = useState(0)
  const [reviewRange, setReviewRange] = useState<ReviewRange>(openRequest?.scope ?? "uncommitted")
  const [changes, setChanges] = useState<DesktopGitChangesResult | null>(null)
  const [loadedChangesKey, setLoadedChangesKey] = useState("")
  const [activePath, setActivePath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified")
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const { resolvedTheme: themeType } = useAppearance()
  const handledOpenRequestRef = useRef<number | null>(null)
  const changesRequestVersionRef = useRef(0)
  const lastTurnFilePaths = useMemo(() => collectLastTurnFilePaths(sessionView), [sessionView])
  const namespace = useMemo(
    () => ({ scopeId, rootPath: selectedProjectPath ?? "", range: reviewRange, ignoreWhitespace }),
    [scopeId, selectedProjectPath, reviewRange, ignoreWhitespace]
  )
  const changesKey = JSON.stringify([scopeId, selectedProjectPath, reviewRange, ignoreWhitespace])
  const visibleChanges = loadedChangesKey === changesKey ? changes : null
  const marks = useReviewedFiles((state) => state.marks)
  const reviewedPaths = useMemo(
    () =>
      new Set(
        (visibleChanges?.files ?? [])
          .filter((file) => marks[reviewFileKey(namespace, file.path)])
          .map((file) => file.path)
      ),
    [visibleChanges, marks, namespace]
  )
  const activePathRef = useRef(activePath)
  const viewportRef = useRef<HTMLDivElement>(null)
  const refreshPosition = useRef<{ key: string; top: number; left: number } | null>(null)
  const marking = useRef(false)
  const [markingPath, setMarkingPath] = useState<string | null>(null)
  useEffect(() => {
    activePathRef.current = activePath
  }, [activePath])

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
        setLoadedChangesKey(changesKey)
        setActivePath((current) =>
          current && visibleResult.files.some((file) => file.path === current)
            ? current
            : (visibleResult.files[0]?.path ?? null)
        )
        setLoadState("ready")
        if (force) setPatchRevision((current) => current + 1)
        const nextActive = visibleResult.files.some((file) => file.path === activePathRef.current)
          ? activePathRef.current
          : (visibleResult.files[0]?.path ?? null)
        void revalidateReviewedFiles(
          namespace,
          visibleResult.files.map((file) => file.path),
          nextActive,
          async (path) =>
            (
              await window.desktop.git.fileDiff({
                rootPath: selectedProjectPath,
                path,
                status: visibleResult.files.find((file) => file.path === path)?.status,
                scope: gitScopeForRange(reviewRange),
                ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
              })
            ).patch,
          () => requestVersion === changesRequestVersionRef.current
        )
      } catch (loadError) {
        if (requestVersion !== changesRequestVersionRef.current) return
        setError(errorMessage(loadError))
        setLoadState("error")
      }
    },
    [ignoreWhitespace, lastTurnFilePaths, reviewRange, selectedProjectPath, namespace, changesKey]
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
      if (
        !visibleChanges?.files.length ||
        (path && !visibleChanges.files.some((file) => file.path === path))
      ) {
        void loadChanges()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [visibleChanges?.files, loadChanges, openRequest, reviewRange, selectedProjectPath])

  const activeFile = visibleChanges?.files.find((file) => file.path === activePath) ?? null
  const diffKey = JSON.stringify([
    selectedProjectPath,
    reviewRange,
    ignoreWhitespace,
    activePath,
    activeFile?.status,
  ])
  const currentDiff =
    diff.key === diffKey
      ? diff
      : {
          state: "loading" as const,
          patch: "",
          error: null,
          refreshing: false,
          fingerprint: undefined,
        }
  useLayoutEffect(() => {
    const position = refreshPosition.current
    if (!position || diff.key !== position.key || diff.refreshing) return
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollTop = position.top
      viewport.scrollLeft = position.left
    }
    refreshPosition.current = null
  }, [diff])

  useEffect(() => {
    if (!selectedProjectPath || !activePath || !activeFile) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      const reviewKey = reviewFileKey(namespace, activePath)
      const decision = useReviewedFiles.getState().decisions[reviewKey] ?? 0
      setDiff((current) =>
        current.key === diffKey && current.state === "ready"
          ? { ...current, refreshing: true, error: null }
          : { key: diffKey, patch: "", state: "loading", error: null, refreshing: true }
      )
      void window.desktop.git
        .fileDiff({
          rootPath: selectedProjectPath,
          path: activePath,
          status: activeFile?.status,
          scope: gitScopeForRange(reviewRange),
          ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
        })
        .then(async (result) => {
          if (cancelled) return
          const fingerprint = result.patch.startsWith("diff --git")
            ? await reviewPatchFingerprint(result.patch)
            : undefined
          if (cancelled) return
          useReviewedFiles.getState().observe(reviewKey, fingerprint ?? "", decision)
          setDiff({
            key: diffKey,
            patch: result.patch,
            state: "ready",
            error: null,
            refreshing: false,
            fingerprint,
          })
        })
        .catch((loadError: unknown) => {
          if (cancelled) return
          useReviewedFiles.getState().observe(reviewKey, "", decision)
          setDiff((current) =>
            current.key === diffKey && current.state === "ready"
              ? { ...current, error: errorMessage(loadError), refreshing: false }
              : {
                  key: diffKey,
                  patch: "",
                  state: "error",
                  error: errorMessage(loadError),
                  refreshing: false,
                }
          )
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    activeFile?.status,
    activePath,
    ignoreWhitespace,
    reviewRange,
    selectedProjectPath,
    diffKey,
    patchRevision,
    namespace,
  ])

  const toggleReviewed = async (file: DesktopGitChangedFile): Promise<void> => {
    if (
      !selectedProjectPath ||
      marking.current ||
      (file.path === activePath &&
        (currentDiff.state !== "ready" || currentDiff.refreshing || currentDiff.error))
    )
      return
    const key = reviewFileKey(namespace, file.path)
    const store = useReviewedFiles.getState()
    if (store.marks[key]) {
      store.setReviewed(key, store.marks[key]!, false)
      return
    }
    marking.current = true
    const version = changesRequestVersionRef.current
    setMarkingPath(file.path)
    try {
      const patch =
        file.path === activePath
          ? currentDiff.patch
          : (
              await window.desktop.git.fileDiff({
                rootPath: selectedProjectPath,
                path: file.path,
                status: file.status,
                scope: gitScopeForRange(reviewRange),
                ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
              })
            ).patch
      if (!patch.startsWith("diff --git")) return
      const fingerprint = await reviewPatchFingerprint(patch)
      if (version !== changesRequestVersionRef.current) return
      useReviewedFiles.getState().setReviewed(key, fingerprint, true)
    } catch (failure) {
      toast.error("无法更新审阅状态", errorMessage(failure))
    } finally {
      marking.current = false
      setMarkingPath(null)
    }
  }

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
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {preferenceError && (
        <p className="px-3 py-1 text-xs text-destructive">
          Git 显示偏好读取失败，保留当前显示选择：{preferenceError}
        </p>
      )}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/45 px-3">
        {openRequest?.rootPath ? (
          <span className="text-xs text-ui-muted" title={selectedProjectPath}>
            当前工作区差异
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <ReviewRangeSummary
            changes={visibleChanges}
            loading={loadState === "loading"}
            value={reviewRange}
            onChange={setReviewRange}
            reviewedCount={reviewedPaths.size}
          />
        </div>
        <DiffModeToggle value={diffViewMode} onChange={setDiffViewMode} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="刷新改动"
          title="刷新改动"
          onClick={() => {
            const viewport = viewportRef.current
            if (viewport)
              refreshPosition.current = {
                key: diffKey,
                top: viewport.scrollTop,
                left: viewport.scrollLeft,
              }
            void loadChanges({ force: true })
          }}
          disabled={loadState === "loading" || currentDiff.refreshing}
          className="text-muted-foreground"
        >
          <RefreshCw
            strokeWidth={1.75}
            className={cn(
              (loadState === "loading" || currentDiff.refreshing) &&
                "animate-spin motion-reduce:animate-none"
            )}
          />
        </Button>
      </div>

      {loadState === "loading" && !visibleChanges && (
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

      {loadState === "ready" && visibleChanges?.files.length === 0 && (
        <DesktopEmptyState
          icon={GitPullRequestDraft}
          size="sm"
          title="没有待审阅改动"
          description="当前项目相对 HEAD 没有文件变化。"
        />
      )}

      {visibleChanges && visibleChanges.files.length > 0 && (
        <ChangedFileStream
          files={visibleChanges.files}
          activePath={activePath}
          onSelect={setActivePath}
          reviewedPaths={reviewedPaths}
          markingPath={markingPath}
          onToggleReviewed={(file) => void toggleReviewed(file)}
          viewportRef={viewportRef}
          canMarkActive={
            currentDiff.state === "ready" &&
            !currentDiff.refreshing &&
            !currentDiff.error &&
            !!currentDiff.fingerprint
          }
          onViewportScroll={(top, left) => {
            if (refreshPosition.current)
              refreshPosition.current = { ...refreshPosition.current, top, left }
          }}
          diff={
            <InlineDiffPreview
              file={visibleChanges.files.find((file) => file.path === activePath) ?? null}
              patch={currentDiff.patch}
              state={currentDiff.state}
              error={currentDiff.error}
              themeType={themeType}
              diffViewMode={diffViewMode}
              source={namespace}
              refreshing={currentDiff.refreshing}
              onOpenFile={
                selectedProjectPath === selectedProject?.path ? layout?.openFile : undefined
              }
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
