import { describe, expect, expectTypeOf, it } from "vitest"

import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

import { resolveTerminalCreateTarget } from "../terminal-runtime-model"

describe("resolveTerminalCreateTarget", () => {
  const session = { id: "s1", projectId: undefined }

  it("uses the session execution environment by default", () => {
    const target = resolveTerminalCreateTarget({
      session,
    })

    expect(target).toEqual({
      runtime: "environment",
      scope: { kind: "session", sessionId: "s1" },
    })
    expectTypeOf(target.scope).toEqualTypeOf<
      NonNullable<DesktopTerminalCreateInput["scope"]>
    >()
  })

  it("uses the environment for native sessions too", () => {
    expect(resolveTerminalCreateTarget({
      session,
    })).toMatchObject({ runtime: "environment" })
  })
})
