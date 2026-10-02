import { describe, expect, it } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"

import {
  buildAssistantContent,
  collectChangedFiles,
  parseFileReference,
  summarizeToolCall,
  toolCallStatus,
  toolDisplayName,
} from "../message-render-model"

describe("message render model", () => {
  it("shows the number of ordered edits in the existing tool summary", () => {
    expect(summarizeToolCall(toolPart("Edit", { file_path: "a.ts", edits: [
      { old_string: "a", new_string: "A" }, { old_string: "b", new_string: "B" },
    ] }))).toMatchObject({ name: "编辑文件", detail: "a.ts · 2 处修改" });
  });

  it.each([
    ["Edit", { arguments: { file_path: "C:/workspace/index.html", old_string: "old", new_string: "new" } }, "C:/workspace/index.html"],
    ["Shell", { arguments: { command: "Get-Content -LiteralPath index.html" } }, "Get-Content -LiteralPath index.html"],
    ["Shell", { arguments: { arguments: { command: "npm run dev" } } }, "npm run dev"],
  ])("summarizes wrapped %s parameters", (name, input, detail) => {
    expect(summarizeToolCall(toolPart(name, input)).detail).toBe(detail);
  });

  it("keeps explicit top-level fields instead of replacing them with nested business arguments", () => {
    expect(summarizeToolCall(toolPart("Read", {
      file_path: "root.txt", arguments: { file_path: "nested.txt" },
    })).detail).toBe("root.txt");
  });

  it("recognizes failures recorded in separate tool results", () => {
    const call = { ...toolPart("Shell", { command: "exit 1" }), status: "running" as const };
    const result = { ...toolPart("Shell", {}), type: "tool_result" as const, isError: true };
    expect(toolCallStatus(call, result)).toBe("failed");
    expect(toolCallStatus(call, { ...result, isError: false })).toBe("completed");
  });

  it("does not claim that a failed edit changed a file", () => {
    const edit = { ...toolPart("Edit", { arguments: { file_path: "index.html" } }), status: "failed" as const, isError: true };
    expect(collectChangedFiles([edit])).toEqual([]);
  });

  it.each([
    { executionState: "unknown" }, { failureKind: "unknown_outcome" }, { outcome: "unknown" },
  ])("does not summarize unknown edits as changed files: %j", (metadata) => {
    const edit = { ...toolPart("Edit", { file_path: "index.html" }), metadata };
    expect(collectChangedFiles([edit])).toEqual([]);
  });

  it("does not summarize unknown outcomes in separate results or stored output", () => {
    const edit = { ...toolPart("Edit", { file_path: "index.html" }), toolUseId: "edit" };
    const separate = { ...toolPart("Edit", {}), id: "result", toolUseId: "edit", type: "tool_result" as const, metadata: { executionState: "unknown" } };
    expect(collectChangedFiles([edit, separate])).toEqual([]);
    expect(collectChangedFiles([{ ...edit, output: { executionState: "unknown" } }])).toEqual([]);
  });

  it("does not summarize a successful not_started Write no-op as a changed file", () => {
    const write = { ...toolPart("Write", { file_path: "index.html" }), metadata: { executionState: "not_started" } };
    expect(toolCallStatus(write)).toBe("completed");
    expect(collectChangedFiles([write])).toEqual([]);
  });

  it.each([{ executionState: "not_started" }, { failureKind: "unknown_outcome" }])("preserves completed result facts over older call metadata: %j", metadata => {
    const edit = { ...toolPart("Edit", { file_path: "index.html" }), toolUseId: "edit", metadata };
    const result = { ...toolPart("Edit", {}), id: "result", toolUseId: "edit", type: "tool_result" as const, metadata: { executionState: "completed" } };
    expect(collectChangedFiles([edit, result])).toEqual([{ path: "index.html", additions: 0, deletions: 0, hasStats: false }]);
  });

  it.each([{ failureKind: "unknown_outcome" }, { outcome: "unknown" }])("prefers latest legacy unknown result over an older completed call: %j", metadata => {
    const edit = { ...toolPart("Edit", { file_path: "index.html" }), toolUseId: "edit", metadata: { executionState: "completed" } };
    const result = { ...toolPart("Edit", {}), id: "result", toolUseId: "edit", type: "tool_result" as const, metadata };
    expect(collectChangedFiles([edit, result])).toEqual([]);
    expect(collectChangedFiles([edit, { ...result, metadata: {}, output: metadata }])).toEqual([]);
  });

  it("prefers valid state over legacy unknown fields within the latest result", () => {
    const edit = { ...toolPart("Edit", { file_path: "index.html" }), toolUseId: "edit", metadata: { executionState: "unknown" } };
    const result = { ...toolPart("Edit", {}), id: "result", toolUseId: "edit", type: "tool_result" as const,
      metadata: { outcome: "unknown" }, output: { executionState: "completed" } };
    expect(collectChangedFiles([edit, result])).toEqual([{ path: "index.html", additions: 0, deletions: 0, hasStats: false }]);
  });



  it("uses result metadata for the actual shell display name", () => {
    const call = toolPart("Shell", { command: "Get-ChildItem" })
    const result = {
      ...toolPart("Shell", {}),
      type: "tool_result" as const,
      metadata: { shellDialect: "pwsh", shellDisplayName: "PowerShell 7.6" },
    }

    expect(toolDisplayName(call, result)).toBe("PowerShell 7.6")
    expect(toolDisplayName(toolPart("Bash", {}), {
      ...toolPart("Bash", {}),
      type: "tool_result",
      metadata: { shellDialect: "powershell", shell: "powershell.exe" },
    })).toBe("PowerShell")
    expect(toolDisplayName(toolPart("Bash", {}))).toBe("Shell")
    expect(toolDisplayName(toolPart("Read", {}))).toBe("Read")
  })

  it("preserves commentary and final-answer phase metadata", () => {
    const part = {
      ...toolPart("Read", {}),
      type: "text" as const,
      text: "I will inspect it.",
      metadata: { phase: "commentary" },
    }

    expect(buildAssistantContent([part])).toEqual([
      {
        id: "part-1",
        type: "markdown",
        text: "I will inspect it.",
        phase: "commentary",
      },
    ])
  })

  it("preserves adjacent assistant attachments as one render unit", () => {
    const first = attachmentPart("part-image-1", "att-image-1", "image/png")
    const second = attachmentPart("part-image-2", "att-image-2", "image/webp")

    expect(buildAssistantContent([first, second])).toEqual([{
      id: "part-image-1",
      type: "attachments",
      parts: [first, second],
    }])
  })

  it("projects ImageGeneration as a dedicated unit instead of a normal tool", () => {
    const imageTool = imageToolPart({ status: "running", ratio: "16:9" })

    expect(buildAssistantContent([imageTool])).toEqual([{
      id: "image-tool-1",
      type: "image_generation",
      call: imageTool,
      hasAttachments: false,
    }])
  })

  it("links generated attachments to their image tool without changing regular attachments", () => {
    const imageTool = imageToolPart({ status: "completed", ratio: "3:2" })
    const generated = {
      ...attachmentPart("generated-1", "att-generated", "image/png"),
      metadata: {
        source: "image_generation",
        toolUseId: "image-tool-1",
      },
    }
    const regular = attachmentPart("regular-1", "att-regular", "image/png")

    expect(buildAssistantContent([imageTool, generated, regular])).toEqual([
      {
        id: "image-tool-1",
        type: "image_generation",
        call: imageTool,
        hasAttachments: true,
      },
      {
        id: "generated-1",
        type: "generated_attachments",
        parts: [generated],
        toolUseId: "image-tool-1",
        ratio: "3:2",
      },
      {
        id: "regular-1",
        type: "attachments",
        parts: [regular],
      },
    ])
  })

  it("keeps generated attachments from separate tool calls in separate groups", () => {
    const first = {
      ...attachmentPart("generated-1", "att-1", "image/png"),
      metadata: { source: "image_generation", toolUseId: "image-tool-1" },
    }
    const second = {
      ...attachmentPart("generated-2", "att-2", "image/png"),
      metadata: { source: "image_generation", toolUseId: "image-tool-2" },
    }

    expect(buildAssistantContent([
      imageToolPart({ id: "image-tool-1", ratio: "not-a-ratio" }),
      first,
      imageToolPart({ id: "image-tool-2", ratio: "9:16" }),
      second,
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "generated_attachments",
        toolUseId: "image-tool-1",
        ratio: "1:1",
        parts: [first],
      }),
      expect.objectContaining({
        type: "generated_attachments",
        toolUseId: "image-tool-2",
        ratio: "9:16",
        parts: [second],
      }),
    ]))
  })

  it("recognizes project files but rejects web links", () => {
    expect(parseFileReference("apps/desktop/src/App.tsx:42")).toEqual({
      path: "apps/desktop/src/App.tsx",
      line: 42,
    })
    expect(parseFileReference("/D:/repo/src/App.tsx:42")).toEqual({
      path: "D:/repo/src/App.tsx",
      line: 42,
    })
    expect(parseFileReference("https://example.com/App.tsx")).toBeNull()
  })

  it("strips the Markdown slash only from Windows drive paths", () => {
    expect(parseFileReference("/E:/code/vykor/My File.ts:7")).toEqual({
      path: "E:/code/vykor/My File.ts",
      line: 7,
    })
    expect(parseFileReference("src/a.ts:1")).toEqual({ path: "src/a.ts", line: 1 })
    expect(parseFileReference("src/My File.ts:7")).toBeNull()
  })

  it("collects files and line stats from an apply patch call", () => {
    const part = toolPart("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/App.tsx",
        "-const oldValue = true",
        "+const newValue = true",
        "+const enabled = true",
        "*** Add File: src/new-file.ts",
        "+export const value = 1",
        "*** End Patch",
      ].join("\n"),
    })

    expect(collectChangedFiles([part])).toEqual([
      { path: "src/App.tsx", additions: 2, deletions: 1, hasStats: true },
      { path: "src/new-file.ts", additions: 1, deletions: 0, hasStats: true },
    ])
  })

  it("collects a structured path from a write tool", () => {
    expect(collectChangedFiles([toolPart("write_file", { file_path: "src/output.ts" })])).toEqual([
      { path: "src/output.ts", additions: 0, deletions: 0, hasStats: false },
    ])
  })

  it("shows completed, empty, and failed local OCR states without claiming image understanding", () => {
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { attachment_id: "att-1" }),
      metadata: { attachmentOcr: { status: "completed", cached: true } },
    })).toEqual({ name: "已使用本地 OCR 提取文字", detail: "已复用识别结果" })
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { attachment_id: "att-1" }),
      metadata: { attachmentOcr: { status: "no_text_detected" } },
    })).toEqual({ name: "本地 OCR 未检测到文字", detail: "不能描述图片" })
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { attachment_id: "att-1" }),
      status: "failed",
      isError: true,
    })).toEqual({ name: "本地 OCR 提取失败", detail: "可以重新发送消息重试" })
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { image_path: "attachment://att-1" }),
      status: "failed",
      isError: true,
      metadata: { failureKind: "command" },
    })).toEqual({ name: "本地 OCR 未能启动", detail: "图片引用无效，请重新发送图片后重试" })
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { attachment_id: "att-1" }),
      status: "failed",
      isError: true,
      metadata: { failureKind: "command" },
    })).toEqual({ name: "本地 OCR 未能启动", detail: "请重新发送消息后重试" })
    expect(summarizeToolCall({
      ...toolPart("ImageToText", { image_path: "receipt.png" }),
      status: "failed",
      isError: true,
      metadata: { failureKind: "command" },
    })).toEqual({ name: "本地 OCR 未能启动", detail: "请重新发送消息后重试" })
  })
})

function toolPart(toolName: string, input: Record<string, unknown>): DesktopSessionPart {
  return {
    id: "part-1",
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "tool",
    status: "completed",
    toolName,
    input,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function attachmentPart(
  id: string,
  assetId: string,
  mediaType: string
): DesktopSessionPart {
  return {
    id,
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "attachment",
    status: "completed",
    assetId,
    intent: "tool_resource",
    displayName: `${assetId}.png`,
    mediaType,
    sizeBytes: 128,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function imageToolPart(options: {
  id?: string
  status?: DesktopSessionPart["status"]
  ratio?: string
}): DesktopSessionPart {
  const id = options.id ?? "image-tool-1"
  return {
    id,
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "tool",
    status: options.status ?? "completed",
    toolUseId: id,
    toolName: "ImageGeneration",
    input: { prompt: "draw a fox", ratio: options.ratio },
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
