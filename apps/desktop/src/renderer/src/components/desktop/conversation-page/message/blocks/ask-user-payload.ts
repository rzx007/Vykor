import type { DesktopPermissionRequest } from "@shared/session-types"

export function isAskUserPermission(permission: DesktopPermissionRequest): boolean {
  const input = permission.payload.input
  return Boolean(
    permission.toolName === "AskUser" &&
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as Record<string, unknown>).kind === "question"
  )
}
