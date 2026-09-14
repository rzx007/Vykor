import { describe, expect, it, vi } from "vitest"

import type { DesktopModel } from "../../../shared/session-types"
import {
  resolveBootstrapRuntimeSelection,
  resolveDesktopRuntimeSnapshot,
} from "./runtime-selection"
import { DesktopSessionService } from "./session-service"

const models: DesktopModel[] = [
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    provider: "Codex Subscription",
    providerName: "codex",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "Gemini",
    providerName: "gemini",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "OpenAI",
    providerName: "openai",
  },
]

describe("resolveBootstrapRuntimeSelection", () => {
  it("prefers the configured provider and switches to one of its models when the saved model belongs elsewhere", () => {
    expect(resolveBootstrapRuntimeSelection(models, "gpt-5.3-codex-spark", "gemini")).toEqual({
      model: "gemini-2.5-pro",
      provider: "gemini",
    })
  })

  it("keeps the saved provider/model pair when they still match", () => {
    expect(resolveBootstrapRuntimeSelection(models, "gemini-2.5-pro", "gemini")).toEqual({
      model: "gemini-2.5-pro",
      provider: "gemini",
    })
  })

  it("derives the provider from the saved model when no provider is configured", () => {
    expect(resolveBootstrapRuntimeSelection(models, "gpt-5.4", undefined)).toEqual({
      model: "gpt-5.4",
      provider: "openai",
    })
  })

  it("falls back to the first available model when there is no saved runtime selection", () => {
    expect(resolveBootstrapRuntimeSelection(models, undefined, undefined)).toEqual({
      model: "gpt-5.3-codex-spark",
      provider: "codex",
    })
  })
})

describe("resolveDesktopRuntimeSnapshot", () => {
  it("returns normalized models and patch flags from the same runtime resolution", () => {
    expect(
      resolveDesktopRuntimeSnapshot(models, {
        model: "gpt-5.3-codex-spark",
        provider: "gemini",
      })
    ).toMatchObject({
      defaultModel: "gemini-2.5-pro",
      defaultProvider: "gemini",
      configuredModel: "gpt-5.3-codex-spark",
      configuredProvider: "gemini",
      needsModelPatch: true,
      needsProviderPatch: false,
    })
  })

  it("keeps a configured model visible when it is no longer in the loaded catalog", () => {
    const snapshot = resolveDesktopRuntimeSnapshot(models, {
      model: "legacy-model",
      provider: undefined,
    })

    expect(snapshot.defaultModel).toBe("legacy-model")
    expect(snapshot.models[0]).toMatchObject({
      id: "legacy-model",
      label: "legacy-model",
      providerName: "Configured",
    })
  })
})

describe("DesktopSessionService.sendPrompt attachments", () => {
  it("forwards a structured conversation reference", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })
    const items = [
      { type: "context" as const, kind: "conversation" as const, id: "session-2", displayName: "技能安装" },
      { type: "text" as const, text: "继续处理" },
    ]

    await service.sendPrompt({ id: "input-context", sessionId: "session-1", items, attachments: [] })

    expect(admitPrompt).toHaveBeenCalledWith("session-1", expect.objectContaining({ items }))
  })

  it("forwards a structured plugin capability reference", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })
    const items = [
      {
        type: "capability" as const,
        kind: "plugin" as const,
        pluginId: "dev.openharness.text-inspector",
        displayName: "text-inspector",
      },
      { type: "text" as const, text: "检查这段内容" },
    ]

    await service.sendPrompt({ id: "input-plugin", sessionId: "session-1", items, attachments: [] })

    expect(admitPrompt).toHaveBeenCalledWith("session-1", expect.objectContaining({ items }))
  })

  it("forwards ordered structured items without re-parsing a selected skill", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })
    const items = [
      { type: "text" as const, text: "画一下" },
      {
        type: "skill" as const,
        name: "archify",
        path: "D:/skills/archify/SKILL.md",
        displayName: "Archify",
        source: "user" as const,
      },
      { type: "text" as const, text: "系统架构" },
    ]

    await service.sendPrompt({
      id: "input-skill",
      sessionId: "session-1",
      items,
      attachments: [],
    })

    expect(admitPrompt).toHaveBeenCalledWith("session-1", {
      id: "input-skill",
      items,
      delivery: "queue",
      attachments: [],
      metadata: {
        origin: {
          client: "desktop",
          component: "composer",
          action: "append_prompt",
        },
      },
    })
  })

  it("accepts a selected skill without task text or attachments", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })

    await service.sendPrompt({
      id: "input-skill-only",
      sessionId: "session-1",
      items: [
        {
          type: "skill",
          name: "archify",
          path: "D:/skills/archify/SKILL.md",
          displayName: "Archify",
        },
      ],
      attachments: [],
    })

    expect(admitPrompt).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        items: [
          expect.objectContaining({ name: "archify", path: "D:/skills/archify/SKILL.md" }),
        ],
      })
    )
  })

  it("accepts an attachment-only prompt and preserves attachment order", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })

    await service.sendPrompt({
      id: "input-1",
      sessionId: "session-1",
      items: [],
      attachments: [
        { assetId: "att-b", intent: "auto", displayName: "b.png" },
        { assetId: "att-a", intent: "auto", displayName: "a.pdf" },
      ],
    })

    expect(admitPrompt).toHaveBeenCalledWith("session-1", {
      id: "input-1",
      items: [],
      delivery: "queue",
      attachments: [
        { assetId: "att-b", intent: "auto", displayName: "b.png" },
        { assetId: "att-a", intent: "auto", displayName: "a.pdf" },
      ],
      metadata: {
        origin: {
          client: "desktop",
          component: "composer",
          action: "append_prompt",
        },
      },
    })
  })

  it("rejects a prompt when both text and attachments are empty", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })

    await expect(
      service.sendPrompt({
        id: "input-empty",
        sessionId: "session-1",
        items: [{ type: "text", text: "   " }],
        attachments: [],
      })
    ).rejects.toThrow("消息内容和附件不能同时为空")
    expect(admitPrompt).not.toHaveBeenCalled()
  })

  it("preserves ordered refs when editing an attachment-only prompt", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt: vi.fn(), editLatestPrompt })

    await service.editLatestPrompt({
      id: "edit-1",
      sessionId: "session-1",
      sourceMessageId: "message-1",
      items: [],
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "a.pdf" },
      ],
    })

    expect(editLatestPrompt).toHaveBeenCalledWith("session-1", {
      id: "edit-1",
      sourceMessageId: "message-1",
      items: [],
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "a.pdf" },
      ],
      metadata: {
        origin: {
          client: "desktop",
          component: "latest-message-editor",
          action: "edit_latest_prompt",
        },
      },
    })
  })
})

describe("DesktopSessionService.listCommands", () => {
  it("keeps Skills plus only commands with a Desktop execution adapter", async () => {
    const listCommands = vi.fn(async () => [
      { name: "/compact", kind: "session" as const, selection: "execute" as const, requiresEmptyComposer: true },
      { name: "/review", kind: "session" as const, selection: "submenu" as const, requiresEmptyComposer: true },
      { name: "/skills", kind: "session" as const, selection: "execute" as const, requiresEmptyComposer: true },
      { name: "/writing-plans", skillName: "writing-plans", kind: "template" as const, path: "D:/skills/writing-plans/SKILL.md" },
    ])
    const service = serviceWithClient({ listCommands })

    await expect(service.listCommands(process.cwd())).resolves.toEqual([
      expect.objectContaining({ name: "/compact", kind: "session" }),
      expect.objectContaining({ name: "/skills", kind: "session" }),
      expect.objectContaining({ name: "/writing-plans", kind: "template" }),
    ])
    expect(listCommands).toHaveBeenCalledWith({ cwd: process.cwd() })
  })

  it("runs compact through the native session API", async () => {
    const compactSession = vi.fn(async () => ({ messageCount: 3, compacted: true }))
    const service = serviceWithClient({ compactSession })

    await expect(service.compactSession({ sessionId: "session-1" })).resolves.toEqual({
      messageCount: 3,
    })
    expect(compactSession).toHaveBeenCalledWith("session-1")
  })
})

function serviceWithClient(client: Record<string, unknown>): DesktopSessionService {
  const service = new DesktopSessionService()
  ;(
    service as unknown as {
      clientPromise: Promise<typeof client>
    }
  ).clientPromise = Promise.resolve(client)
  return service
}
