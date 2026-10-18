import { useEffect, useMemo, useRef, useState } from "react"
import { Minus, Plus, Scan } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import {
  graphNodeHeight,
  graphNodeWidth,
  layoutWorkflow,
  workflowImpact,
  workflowTaskLabel,
} from "./workflow-model"
import { WorkflowStatusIcon } from "./workflow-status-icon"

export function WorkflowGraph({
  run,
  selectedId,
  focus,
  onSelect,
}: {
  run: DesktopWorkflowRun
  selectedId?: string
  focus: number
  onSelect(id: string): void
}) {
  const planKey = JSON.stringify(run.tasks.map((task) => [task.id, task.dependencies]))
  // Status updates keep exactly the same coordinates and scroll position.
  const graph = useMemo(() => layoutWorkflow(run.tasks), [planKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [zoom, setZoom] = useState(1)
  const affected = useMemo(() => {
    const selected = run.tasks.find((task) => task.id === selectedId)
    return selected && (selected.status === "failed" || selected.cleanupUnconfirmed)
      ? workflowImpact(run.tasks, selected.id)
      : new Set<string>()
  }, [run.tasks, selectedId])
  const positions = new Map(graph.nodes.map((node) => [node.id, node]))
  useEffect(() => {
    if (!focus || !selectedId) return
    const position = graph.nodes.find((node) => node.id === selectedId)
    if (!position) return
    buttons.current.get(selectedId)?.focus({ preventScroll: true })
    viewport.current?.scrollTo?.({
      left: Math.max(0, position.x * zoom - 24),
      top: Math.max(0, position.y * zoom - 24),
      behavior: "instant",
    })
  }, [focus, selectedId, graph, zoom])
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end gap-2 px-4 py-2 text-xs text-muted-foreground">
        {affected.size ? <span className="sr-only">虚线标记所选问题任务的下游</span> : null}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label="缩小任务图"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label="适应任务图宽度"
            onClick={() =>
              setZoom(
                Math.min(
                  1,
                  Math.max(
                    0.35,
                    ((viewport.current?.clientWidth ?? graph.width) - 16) / graph.width
                  )
                )
              )
            }
          >
            <Scan />
          </Button>
          <Button
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label="放大任务图"
            disabled={zoom >= 1.5}
            onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div
        ref={viewport}
        role="region"
        aria-label="任务关系图"
        tabIndex={0}
        className="max-h-96 scrollbar-thin overflow-auto focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div
          className="relative"
          style={{ width: graph.width * zoom, height: graph.height * zoom }}
        >
          <div
            className="absolute origin-top-left"
            style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 text-border"
              width={graph.width}
              height={graph.height}
            >
              {run.tasks.flatMap((task) =>
                task.dependencies.map((dependency) => {
                  const from = positions.get(dependency),
                    to = positions.get(task.id)
                  if (!from || !to) return null
                  const x = from.x + graphNodeWidth,
                    y = from.y + graphNodeHeight / 2,
                    targetY = to.y + graphNodeHeight / 2
                  return (
                    <path
                      key={`${dependency}:${task.id}`}
                      d={`M ${x} ${y} C ${x + 24} ${y}, ${to.x - 24} ${targetY}, ${to.x} ${targetY}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      className={cn(
                        (selectedId === dependency || selectedId === task.id) &&
                          "text-muted-foreground"
                      )}
                    />
                  )
                })
              )}
            </svg>
            {graph.nodes.map((node) => {
              const task = run.tasks.find((task) => task.id === node.id)!
              return (
                <button
                  key={node.id}
                  ref={(element) => {
                    if (element) buttons.current.set(node.id, element)
                    else buttons.current.delete(node.id)
                  }}
                  type="button"
                  title={task.title}
                  data-workflow-node={node.id}
                  data-affected={affected.has(node.id)}
                  aria-pressed={selectedId === node.id}
                  aria-label={`${task.title}，${workflowTaskLabel(task)}${affected.has(node.id) ? "，位于所选任务下游" : ""}`}
                  onClick={() => onSelect(node.id)}
                  className={cn(
                    "absolute flex flex-col justify-center gap-2 rounded-xl border bg-background px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    selectedId === node.id && "border-primary bg-accent",
                    affected.has(node.id) && "border-dashed",
                    task.status === "failed" && "border-destructive"
                  )}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: graphNodeWidth,
                    height: graphNodeHeight,
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <WorkflowStatusIcon status={task.status} />
                    <span className="line-clamp-2 text-sm font-medium break-words">
                      {task.title.replace(/^任务\s*\d+\s*[:：]\s*/u, "")}
                    </span>
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground">
                    {workflowTaskLabel(task)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
