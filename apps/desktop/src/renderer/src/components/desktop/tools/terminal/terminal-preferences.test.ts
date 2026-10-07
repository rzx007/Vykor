import { describe, expect, it, vi } from "vitest"
import { DEFAULT_TERMINAL_SETTINGS } from "@shared/terminal-settings-types"
import { pasteTerminalText, terminalDisplayOptions } from "./terminal-preferences"

describe("terminal preferences", () => {
  it("writes no bytes while multiline confirmation is pending or declined", async () => {
    let confirm!: (accepted: boolean) => void
    const send = vi.fn()
    const waiting = pasteTerminalText("echo safe\r\nrm important\n", true, (preview) => {
      expect(preview.lines).toBe(3)
      expect(preview.preview).toContain("rm important")
      return new Promise((resolve) => { confirm = resolve })
    }, send)
    expect(send).not.toHaveBeenCalled()
    confirm(false)
    await expect(waiting).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it("pastes original text once only after acceptance and skips prompts for single lines", async () => {
    const send = vi.fn()
    const confirm = vi.fn(async () => true)
    await pasteTerminalText("a\nb", true, confirm, send)
    expect(send).toHaveBeenCalledExactlyOnceWith("a\nb")
    confirm.mockClear()
    await pasteTerminalText("echo safe", true, confirm, send)
    expect(confirm).not.toHaveBeenCalled()
    expect(send).toHaveBeenLastCalledWith("echo safe")
  })

  it("follows the current code font while respecting terminal size and reduced motion", () => {
    expect(terminalDisplayOptions({ ...DEFAULT_TERMINAL_SETTINGS, fontSize: 17, scrollback: 12000, cursorStyle: "bar" }, "CodeFont, monospace", true)).toEqual({ fontFamily: "CodeFont, monospace", fontSize: 17, scrollback: 12000, cursorStyle: "bar", cursorBlink: false })
    expect(terminalDisplayOptions({ ...DEFAULT_TERMINAL_SETTINGS, fontMode: "independent", fontFamily: "Consolas" }, "CodeFont", false)).toMatchObject({ cursorBlink: true, fontFamily: '"Consolas", "Geist Mono Variable", "Microsoft YaHei UI", monospace' })
  })
})
