import type {
  DesktopSessionPart,
  DesktopSessionTask,
  DesktopSessionView,
} from "@shared/session-types"

type SourceDetails = {
  id: string
  label: string
  origin: "provided" | "read" | "search"
  createdAt: number
}
export type SessionSummarySource = SourceDetails &
  (
    | { kind: "file"; path: string }
    | { kind: "attachment"; assetId: string }
    | { kind: "url"; url: string }
  )

export function summarizeAgentTasks(tasks: readonly DesktopSessionTask[]) {
  const counts = { total: 0, active: 0, completed: 0, failed: 0, stopped: 0 }
  for (const task of tasks) {
    if (task.type !== "agent" || !task.childSessionId) continue
    counts.total++
    if (task.status === "pending" || task.status === "running") counts.active++
    else if (task.status === "completed") counts.completed++
    else if (task.status === "failed") counts.failed++
    else counts.stopped++
  }
  return counts
}

export function collectSessionSources(view: DesktopSessionView): SessionSummarySource[] {
  const sources = new Map<string, SessionSummarySource>()
  const priority = { search: 0, provided: 1, read: 2 }
  const add = (source: SessionSummarySource): void => {
    const previous = sources.get(source.id)
    if (
      !previous ||
      priority[source.origin] > priority[previous.origin] ||
      (source.origin === previous.origin && source.createdAt > previous.createdAt)
    ) {
      sources.set(source.id, source)
    }
  }
  const addFile = (raw: unknown, origin: "provided" | "read", createdAt: number): void => {
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      /(?:^|[\\/])\.{1,2}[\\/]?$/.test(raw) ||
      /[\\/]$/.test(raw)
    )
      return
    const path = sourceFilePath(raw, view.session.cwd)
    const windows = /^[a-z]:\//i.test(path) || path.startsWith("//")
    add({
      id: `file:${windows ? path.toLowerCase() : path}`,
      kind: "file",
      path,
      label: path.split("/").at(-1) ?? path,
      origin,
      createdAt,
    })
  }
  const addUrl = (
    raw: unknown,
    origin: "read" | "search",
    createdAt: number,
    title?: string
  ): void => {
    if (typeof raw !== "string") return
    try {
      const url = new URL(raw)
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return
      url.hash = ""
      add({
        id: `url:${url.href}`,
        kind: "url",
        url: url.href,
        label: title || `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`,
        origin,
        createdAt,
      })
    } catch {
      /* Invalid or unsupported addresses are not navigable sources. */
    }
  }

  for (const input of view.inputs) {
    if (input.sessionId !== view.session.id) continue
    for (const item of input.items) {
      if (item.type === "mention") addFile(item.path, "provided", input.createdAt)
    }
    for (const attachment of input.attachments) {
      add({
        id: `asset:${attachment.assetId}`,
        kind: "attachment",
        assetId: attachment.assetId,
        label: attachment.displayName,
        origin: "provided",
        createdAt: input.createdAt,
      })
    }
  }

  const parts = view.parts.filter((part) => part.sessionId === view.session.id)
  const results = new Map(
    parts
      .filter((part) => part.type === "tool_result" && part.toolUseId)
      .map((part) => [part.toolUseId!, part])
  )
  for (const call of parts) {
    if (call.type !== "tool") continue
    // Both merged tool outputs and separate tool_result parts exist in stored conversations.
    const result = (call.toolUseId ? results.get(call.toolUseId) : undefined) ?? call
    if (
      call.status !== "completed" ||
      result.status !== "completed" ||
      result.isError ||
      call.isError ||
      result.metadata.executionState === "not_started" ||
      result.output === undefined
    )
      continue
    const text = toolResultText(result)
    if (call.toolName === "Read") {
      if (
        /entries=|0 entries/.test(String(result.metadata.compactSummary ?? "")) ||
        /\(empty directory\)|End of directory\.|Showing entries/.test(text)
      )
        continue
      addFile(call.input?.file_path, "read", result.updatedAt)
    } else if (call.toolName === "WebFetch") {
      const fetchedUrl = text.match(/^URL: (https?:\/\/[^\s]+)$/m)?.[1]
      addUrl(fetchedUrl ?? call.input?.url, "read", result.updatedAt)
    } else if (call.toolName === "WebSearch") {
      // ponytail: only the builtin search format is supported; use structured source metadata for other providers.
      for (const match of text.matchAll(/^\d+\. (.+)\r?\n\s+URL: (https?:\/\/[^\s]+)\s*$/gm)) {
        addUrl(match[2], "search", result.updatedAt, match[1]!.trim())
      }
    }
  }
  return [...sources.values()].sort((left, right) => right.createdAt - left.createdAt)
}

function sourceFilePath(raw: string, cwd: string): string {
  const path = raw.trim().replace(/\\/g, "/")
  const absolute = /^(?:[a-z]:\/|\/)/i.test(path) ? path : `${cwd.replace(/\\/g, "/")}/${path}`
  const prefix = absolute.startsWith("//") ? "//" : absolute.startsWith("/") ? "/" : ""
  const segments: string[] = []
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length && !/^[a-z]:$/i.test(segments.at(-1)!)) segments.pop()
    } else segments.push(segment)
  }
  return prefix + segments.join("/")
}

function toolResultText(part: DesktopSessionPart): string {
  if (typeof part.output === "string") return part.output
  if (!part.output || typeof part.output !== "object") return part.text ?? ""
  const content = (part.output as { content?: unknown }).content
  if (!Array.isArray(content)) return part.text ?? ""
  return content
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : []
    )
    .join("\n")
}

/** Streaming text does not invalidate Git; settled tools/runs/children do. */
export function sessionChangesRevision(view: DesktopSessionView): string {
  return [
    ...view.parts
      .filter(
        (part) =>
          (part.type === "tool" || part.type === "tool_result") &&
          part.status !== "running" &&
          part.status !== "pending"
      )
      .map((part) => `${part.id}:${part.status}:${part.updatedAt}`),
    ...view.runs
      .filter((run) => run.status !== "running" && run.status !== "pending")
      .map((run) => `${run.id}:${run.status}:${run.updatedAt}`),
    ...view.tasks
      .filter((task) => task.type === "agent")
      .map((task) => `${task.id}:${task.status}`),
  ].join("|")
}
