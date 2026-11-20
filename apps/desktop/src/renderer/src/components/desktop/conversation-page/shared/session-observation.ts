import { isChannelSession } from "@renderer/stores/desktop-session/helpers"
import type { DesktopSessionRecord } from "@shared/session-types"

const directiveName = "observe-session"
const sessionIdPattern = /^[^\s\p{Cc}]+$/u

export function isDesktopObservableSession(session: DesktopSessionRecord | null): boolean {
  return session !== null &&
    session.status !== "archived" && session.status !== "closing" &&
    session.parentId === undefined && session.storage !== "memory" &&
    !isChannelSession(session) && sessionIdPattern.test(session.id)
}

export function sessionObservationDirective(sessionId: string): string {
  return `${directiveName} ${sessionId}`
}

export function leadingSessionObservationLine(text: string): string | undefined {
  const line = text.split(/\r?\n/u, 1)[0]!
  const prefix = `${directiveName} `
  return line.startsWith(prefix) && sessionIdPattern.test(line.slice(prefix.length)) ? line : undefined
}
