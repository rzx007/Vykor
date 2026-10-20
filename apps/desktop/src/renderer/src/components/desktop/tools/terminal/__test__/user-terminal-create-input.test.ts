import { expect, it } from "vitest"

import { userTerminalCreateInput } from "../user-terminal-create-input"

it("never forwards a project default shell", () => {
  const projectDefaultShell = "C:\\Windows\\System32\\cmd.exe"
  const input = userTerminalCreateInput({
    scope: { kind: "session", sessionId: "s1" },
    runtime: "local",
    name: "终端 1",
    cols: 80,
    rows: 24,
  })
  expect(input).toEqual({
    scope: { kind: "session", sessionId: "s1" },
    runtime: "local",
    name: "终端 1",
    cols: 80,
    rows: 24,
  })
  expect(input).not.toHaveProperty("shell")
  expect(projectDefaultShell).toBeTruthy()
})
