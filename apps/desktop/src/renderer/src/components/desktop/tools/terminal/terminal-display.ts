import type { DesktopTerminalRecord } from "@shared/terminal-types"

export type TerminalSessionTabInfo = {
  id: string
  title: string
}

export function nextTerminalName(records: DesktopTerminalRecord[], sessionId: string): string {
  const used = new Set(
    records
      .filter((record) => record.scope.kind === "session" && record.scope.sessionId === sessionId)
      .map((record) => /^Terminal (\d+)$/.exec(record.name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
  )
  let index = 1
  while (used.has(index)) index += 1
  return `Terminal ${index}`
}

export function recordBelongsToSession(
  record: DesktopTerminalRecord,
  session: { id: string; projectId?: string } | null
): boolean {
  if (!session) return false
  if (record.scope.kind === "session") return record.scope.sessionId === session.id
  return Boolean(session.projectId && record.scope.projectId === session.projectId)
}

export function clampContextMenuPosition(x: number, y: number): { x: number; y: number } {
  const width = 176
  const height = 200
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function shellName(shell: string): string {
  return (
    shell
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.exe$/i, "") || shell
  )
}

export function toTabInfo(record: DesktopTerminalRecord): TerminalSessionTabInfo {
  return {
    id: record.id,
    title: `${shellName(record.shell)}:${record.cwd}`,
  }
}

export function terminalErrorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}
