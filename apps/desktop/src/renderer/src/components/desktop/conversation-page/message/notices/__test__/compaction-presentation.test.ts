import { describe, expect, it } from "vitest"

import {
  compactionDividerLabel,
  readContextCompactionPresentation,
} from "../compaction-presentation"

describe("compaction presentation", () => {
  it("labels every phase", () => {
    expect(compactionDividerLabel("started")).toBe("正在压缩上下文")
    expect(compactionDividerLabel("completed")).toBe("已压缩上下文")
    expect(compactionDividerLabel("failed")).toBe("上下文压缩失败")
    expect(compactionDividerLabel("interrupted")).toBe("上下文压缩已中断")
  })

  it("reads compaction metadata and ignores other presentations", () => {
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "context_compaction", phase: "completed" },
      })
    ).toEqual({ kind: "context_compaction", phase: "completed" })
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "model_switch", fromModel: "a", toModel: "b" },
      })
    ).toBeNull()
    expect(readContextCompactionPresentation({})).toBeNull()
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "context_compaction", phase: "nonsense" },
      })
    ).toBeNull()
  })
})
