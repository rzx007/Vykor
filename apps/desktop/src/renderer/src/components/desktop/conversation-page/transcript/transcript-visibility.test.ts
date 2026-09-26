import { expect, it } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"
import { visibleTranscriptParts } from "./transcript-visibility"

it.each([true, false])("hides superseded output with showReasoning=%s", (showReasoning) => {
  const part = (id: string, superseded: boolean): DesktopSessionPart => ({
    id, sessionId: "s", messageId: "m", seq: 1, type: "text", status: "completed",
    text: id, metadata: { modelGeneration: { generationId: "g", attempt: 1, superseded, committed: !superseded } },
    createdAt: 1, updatedAt: 1,
  })
  expect(visibleTranscriptParts([part("old", true), part("new", false)], showReasoning).map(p => p.id)).toEqual(["new"])
})
