import type { TerminalSettings } from "@shared/terminal-settings-types"

export function terminalDisplayOptions(settings: TerminalSettings, codeFont: string, reducedMotion: boolean) {
  return {
    fontFamily: settings.fontMode === "code" ? codeFont : `"${settings.fontFamily.replace(/["\\]/g, "")}", "Geist Mono Variable", "Microsoft YaHei UI", monospace`,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink && !reducedMotion,
  }
}

export function multilinePastePreview(text: string): { lines: number; preview: string } {
  return { lines: text.split(/\r\n|\r|\n/).length, preview: text.slice(0, 2000) }
}

export async function pasteTerminalText(
  text: string,
  requireConfirmation: boolean,
  confirm: (value: { lines: number; preview: string }) => Promise<boolean>,
  send: (text: string) => void
): Promise<boolean> {
  if (!text) return false
  if (requireConfirmation && /[\r\n]/.test(text) && !(await confirm(multilinePastePreview(text)))) return false
  send(text)
  return true
}
