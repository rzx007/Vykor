export const SYSTEM_TERMINAL_SHELL_ID = "system"

export function resolveSelectedTerminalShellId(
  savedId: string | null,
  shells: Array<{ id: string }>
): string {
  if (savedId && shells.some((item) => item.id === savedId)) return savedId
  return SYSTEM_TERMINAL_SHELL_ID
}
