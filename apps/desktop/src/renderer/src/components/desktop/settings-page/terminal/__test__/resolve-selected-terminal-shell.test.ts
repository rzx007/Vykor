import { describe, expect, it } from "vitest"

import { resolveSelectedTerminalShellId } from "../resolve-selected-terminal-shell"

const shells = [
  { id: "pwsh", label: "PowerShell 7" },
  { id: "cmd", label: "命令提示符" },
]

describe("resolveSelectedTerminalShellId", () => {
  it("uses the saved id when it is still installed", () => {
    expect(resolveSelectedTerminalShellId("pwsh", shells)).toBe("pwsh")
  })

  it("falls back to system when the saved id is gone or empty", () => {
    expect(resolveSelectedTerminalShellId("git-bash", shells)).toBe("system")
    expect(resolveSelectedTerminalShellId(null, shells)).toBe("system")
  })
})
