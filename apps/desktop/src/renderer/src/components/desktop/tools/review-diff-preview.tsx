import type {
  FileDiff as FileDiffInstance,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"
import {
  ChevronDown,
  ChevronUp,
  FileCode2,
  MessageCirclePlus,
  Search,
  WrapText,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { InputGroup, InputGroupInput } from "@renderer/components/ui/input-group"
import { toast } from "@renderer/lib/toast"
import type { DesktopGitChangedFile } from "@shared/git-types"
import { addTextToComposer } from "./code-selection-actions"
import { listenReviewTextSelection } from "./review-text-selection"
import {
  createReviewDiffModel,
  findReviewMatches,
  reviewRowLine,
  reviewSelectionText,
  stepReviewIndex,
  type ReviewDiffTarget,
  type ReviewSelectionSource,
} from "./review-diff-model"

interface ReviewDiffPreviewProps {
  file: DesktopGitChangedFile
  patch: string
  themeType: "dark" | "light"
  diffViewMode: "unified" | "split"
  baseOptions: FileDiffOptions<undefined, undefined>
  source: Pick<ReviewSelectionSource, "rootPath" | "range"> & { scopeId: string }
  refreshing?: boolean
  onOpenFile?: (path: string, line?: number) => void
}

export function ReviewDiffPreview({
  file,
  patch,
  themeType,
  diffViewMode,
  baseOptions,
  source,
  refreshing = false,
  onOpenFile,
}: ReviewDiffPreviewProps) {
  const model = useMemo(() => createReviewDiffModel(patch), [patch])
  const instance = useRef<{ node: HTMLElement; api: FileDiffInstance } | null>(null)
  const pendingTarget = useRef<{ patch: string; target: ReviewDiffTarget } | null>(null)
  const [selectionState, setSelectionState] = useState<{
    patch: string
    range: SelectedLineRange | null
  }>({ patch, range: null })
  const selection = selectionState.patch === patch ? selectionState.range : null
  const [cursorState, setCursorState] = useState<{
    patch: string
    target: ReviewDiffTarget
  } | null>(null)
  const cursor = cursorState?.patch === patch ? cursorState.target : null
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [searchIndex, setSearchIndex] = useState(-1)
  const [wrap, setWrap] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => findReviewMatches(model, query), [model, query])
  const changes = model?.changes ?? []
  const changeIndex = cursor
    ? changes.findLastIndex((target) => target.rowIndex <= cursor.rowIndex)
    : -1

  const scrollToTarget = useCallback((target: ReviewDiffTarget): boolean => {
    const attached = instance.current
    if (!attached) return false
    const indexes = attached.api.getLineIndex(target.line, target.side)
    const root = attached.node.shadowRoot ?? attached.node
    const candidates = root.querySelectorAll<HTMLElement>(`[data-line="${target.line}"]`)
    const line = Array.from(candidates).find((node) => {
      if (indexes && node.dataset.lineIndex === indexes.join(",")) return true
      return target.side === "deletions"
        ? !!node.closest("[data-deletions]") || node.dataset.lineType === "change-deletion"
        : !node.closest("[data-deletions]") && node.dataset.lineType !== "change-deletion"
    })
    if (!line) return false
    line.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
    return true
  }, [])

  const jump = useCallback(
    (target: ReviewDiffTarget) => {
      setCursorState({ patch, target })
      setSelectionState({
        patch,
        range: { start: target.line, end: target.line, side: target.side },
      })
      pendingTarget.current = scrollToTarget(target) ? null : { patch, target }
    },
    [patch, scrollToTarget]
  )
  const select = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionState({ patch, range })
      if (!range || !model) return
      const side = range.side ?? "additions"
      const rowIndex = model.rows.findIndex((row) => reviewRowLine(row, side) === range.start)
      if (rowIndex >= 0) setCursorState({ patch, target: { line: range.start, side, rowIndex } })
    },
    [model, patch]
  )
  const selectRef = useRef(select)
  const selectionListeners = useRef(new Map<HTMLElement, () => void>())
  useEffect(() => {
    selectRef.current = select
  }, [select])
  const addSelection = useCallback(
    (range: SelectedLineRange | null) => {
      if (!model || !range || refreshing) return
      try {
        addTextToComposer(
          source.scopeId,
          reviewSelectionText(model, range, { ...source, path: file.path, oldPath: file.oldPath })
        )
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "无法添加选区")
      }
    },
    [model, source, file.path, file.oldPath, refreshing]
  )

  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      ...baseOptions,
      diffStyle: diffViewMode,
      themeType,
      overflow: wrap ? "wrap" : "scroll",
      enableLineSelection: true,
      enableGutterUtility: true,
      // 为操作按钮单独留位；Pierre 的行号文字有层级，不能与按钮共用同一区域。
      unsafeCSS: `${baseOptions.unsafeCSS ?? ""}
        [data-column-number], [data-gutter-buffer] {
          padding-left: 32px;
        }
        [data-gutter-utility-slot] {
          left: 4px;
          right: auto;
          width: 24px;
          align-items: flex-start;
          justify-content: center;
          z-index: 2;
        }
      `,
      onLineSelected: select,
      onLineSelectionEnd: select,
      onPostRender: (node, api, phase) => {
        if (phase === "unmount") {
          selectionListeners.current.get(node)?.()
          selectionListeners.current.delete(node)
          if (instance.current?.api === api) instance.current = null
          return
        }
        instance.current = { node, api }
        if (!selectionListeners.current.has(node))
          selectionListeners.current.set(
            node,
            listenReviewTextSelection(node, (range) => selectRef.current(range))
          )
        const pending = pendingTarget.current
        if (pending?.patch === patch && scrollToTarget(pending.target)) pendingTarget.current = null
      },
    }),
    [baseOptions, diffViewMode, themeType, wrap, select, patch, scrollToTarget]
  )

  const moveChange = (direction: -1 | 1) => {
    const index = stepReviewIndex(changeIndex, direction, changes.length)
    if (index >= 0) jump(changes[index]!)
  }
  const moveSearch = (direction: -1 | 1) => {
    const index = stepReviewIndex(searchIndex, direction, matches.length)
    setSearchIndex(index)
    if (index >= 0) jump(matches[index]!)
  }
  const openSearch = () => {
    setSearchOpen(true)
    window.requestAnimationFrame(() => searchInput.current?.focus())
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery("")
    previewRef.current?.focus({ preventScroll: true })
  }
  const sourceTarget = cursor ?? changes[0]
  const sourceLine = sourceTarget ? model?.rows[sourceTarget.rowIndex]?.newLine : 1
  const canOpen = !!onOpenFile && file.status !== "deleted" && sourceLine !== undefined

  if (!model) return <div className="px-3 py-6 text-xs text-muted-foreground">无法解析此补丁</div>
  return (
    <div
      ref={previewRef}
      className="w-full max-w-full min-w-0 overflow-hidden outline-none"
      tabIndex={0}
      aria-label="文件差异"
      aria-busy={refreshing}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault()
          event.stopPropagation()
          openSearch()
        }
        if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault()
          moveChange(event.key === "ArrowDown" ? 1 : -1)
        }
        if (event.key === "Escape" && !searchOpen) {
          setSelectionState({ patch, range: null })
          pendingTarget.current = null
        }
      }}
    >
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border/35 px-2 py-1">
        <ButtonGroup variant="toolbar" aria-label="改动导航">
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label="上一处改动"
            title="上一处改动（Alt+↑）"
            disabled={!changes.length || refreshing}
            onClick={() => moveChange(-1)}
          >
            <ChevronUp strokeWidth={1.75} />
          </Button>
          <span
            className="min-w-9 text-center text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {Math.max(0, changeIndex + 1)}/{changes.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label="下一处改动"
            title="下一处改动（Alt+↓）"
            disabled={!changes.length || refreshing}
            onClick={() => moveChange(1)}
          >
            <ChevronDown strokeWidth={1.75} />
          </Button>
        </ButtonGroup>
        {selection ? (
          <Button
            variant="ghost"
            size="sm"
            shape="pill"
            aria-label="添加选区到输入框"
            disabled={refreshing}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => addSelection(selection)}
          >
            <MessageCirclePlus data-icon="inline-start" strokeWidth={1.75} />
            添加到输入框
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label="查找差异"
            title="查找（Ctrl / Cmd+F）"
            aria-pressed={searchOpen}
            onClick={openSearch}
          >
            <Search strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label="自动换行"
            title="自动换行"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label="打开源码"
            title={sourceLine === undefined ? "旧版行无法跳转到当前源码" : "打开源码"}
            disabled={!canOpen || refreshing}
            onClick={() => {
              const path = /^(?:[A-Za-z]:[\\/]|\/)/.test(file.path)
                ? file.path
                : `${source.rootPath.replace(/[\\/]$/, "")}/${file.path}`
              // 暂存区与磁盘可能不同；有可靠映射前只打开文件。
              onOpenFile?.(path, source.range === "staged" ? undefined : sourceLine)
            }}
          >
            <FileCode2 strokeWidth={1.75} />
          </Button>
        </div>
      </div>
      {searchOpen ? (
        <div className="border-b border-border/35 px-2 py-1.5">
          <InputGroup shape="pill" className="h-8">
            <InputGroupInput
              ref={searchInput}
              aria-label="搜索差异"
              placeholder="查找"
              value={query}
              onChange={(event) => {
                const value = event.target.value
                setQuery(value)
                const first = findReviewMatches(model, value)[0]
                setSearchIndex(first ? 0 : -1)
                if (first) jump(first)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  moveSearch(event.shiftKey ? -1 : 1)
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  closeSearch()
                }
              }}
            />
            {query ? (
              <span
                role="status"
                className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums"
              >
                {Math.max(0, Math.min(searchIndex + 1, matches.length))}/{matches.length}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label="上一个匹配"
              title="上一个匹配（Shift+Enter）"
              disabled={!matches.length}
              onClick={() => moveSearch(-1)}
            >
              <ChevronUp strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label="下一个匹配"
              title="下一个匹配（Enter）"
              disabled={!matches.length}
              onClick={() => moveSearch(1)}
            >
              <ChevronDown strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label="关闭查找"
              title="关闭查找（Esc）"
              onClick={closeSearch}
            >
              <X strokeWidth={1.75} />
            </Button>
          </InputGroup>
        </div>
      ) : null}
      <div
        onPointerDownCapture={(event) => {
          if (!(event.target as HTMLElement).closest("button,input"))
            event.currentTarget.parentElement?.focus({ preventScroll: true })
        }}
      >
        <FileDiff
          fileDiff={model.fileDiff}
          options={options}
          selectedLines={selection}
          className="desktop-review-diff block w-full max-w-full min-w-0"
          renderGutterUtility={(getHoveredLine) => (
            <Button
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label="添加选区到输入框"
              title="添加到输入框"
              className="size-5 bg-popover text-popover-foreground hover:bg-accent [&_svg]:size-3.5"
              disabled={refreshing}
              onClick={() => {
                const hovered = getHoveredLine()
                addSelection(
                  selection ??
                    (hovered
                      ? { start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side }
                      : null)
                )
              }}
            >
              <MessageCirclePlus strokeWidth={1.75} />
            </Button>
          )}
        />
      </div>
    </div>
  )
}
