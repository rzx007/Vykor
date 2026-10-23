// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn(), setState: vi.fn() }))
vi.mock("@renderer/lib/toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { setState: mocks.setState },
}))
vi.mock("../provider-brand-icons", () => ({ resolveProviderBrandIcon: () => undefined }))
import { ProviderDefaultsControl } from "../provider-defaults-control"

const initial: ProviderDefaultsSnapshot = {
  provider: "test",
  model: "model-a",
  effort: "low",
  disabled: false,
  revision: "original",
  verified: {},
  fastModeAvailable: false,
  fastModeReason: "当前服务未提供独立加速参数",
  models: [
    {
      id: "model-a",
      label: "Model A",
      provider: "Test Provider",
      providerName: "test",
      reasoningEfforts: ["low", "high"],
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      inputCapabilities: { image: "native" },
    },
  ],
}

describe("automatic model defaults", () => {
  let container: HTMLDivElement, root: Root | null
  const snapshot = vi.fn(async () => initial)
  const updateEffort =
    vi.fn<
      (input: {
        effort: string | null
        expectedRevision: string
      }) => Promise<ProviderDefaultsSnapshot>
    >()
  const setDefaultModel = vi.fn()
  const onChanged = vi.fn(async () => {})
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.clearAllMocks()
    onChanged.mockReset().mockResolvedValue(undefined)
    snapshot.mockReset().mockResolvedValue(initial)
    updateEffort
      .mockReset()
      .mockImplementation(async (input) => ({ ...initial, effort: input.effort, revision: "next" }))
    setDefaultModel.mockReset()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { providerDefaults: { snapshot, updateEffort }, sessions: { setDefaultModel } },
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    if (root) act(() => root!.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const render = () =>
    act(async () => root!.render(<ProviderDefaultsControl onChanged={onChanged} />))
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)
  const choose = (label: string) => act(async () => button(label)!.click())
  const advance = (ms = 400) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it("shows capability icons without save labels or the explanatory paragraph", async () => {
    await render()
    expect(container.textContent).toContain("Model A")
    expect(container.textContent).toContain("Test Provider")
    expect(container.querySelector('[aria-label="支持文本输入"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="支持图片输入"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="支持视频输入"]')).toBeNull()
    expect(container.querySelector('[aria-label="默认模型说明"]')).not.toBeNull()
    expect(container.textContent).not.toContain("用于新对话")
    expect(container.textContent).not.toContain("可读图片")
    expect(container.textContent).not.toContain("当前默认")
    expect(container.textContent).not.toContain("待保存")
    expect(button("保存")).toBeUndefined()
    expect(button("取消")).toBeUndefined()
    expect(button("轻量思考")?.getAttribute("aria-pressed")).toBe("true")
    await advance()
    expect(updateEffort).not.toHaveBeenCalled()
  })

  it("debounces successive choices and persists only the final API value", async () => {
    await render()
    await choose("深入思考")
    expect(button("深入思考")?.getAttribute("aria-pressed")).toBe("true")
    await advance(300)
    await choose("交给模型")
    await advance(399)
    expect(updateEffort).not.toHaveBeenCalled()
    await advance(1)
    expect(updateEffort).toHaveBeenCalledExactlyOnceWith({
      effort: null,
      expectedRevision: "original",
    })
    expect(onChanged).toHaveBeenCalledOnce()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(button("交给模型")?.getAttribute("aria-pressed")).toBe("true")
  })

  it("does not save when the user returns to the saved choice during debounce", async () => {
    await render()
    await choose("深入思考")
    await advance(200)
    await choose("轻量思考")
    await advance()
    expect(updateEffort).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("disables edits during a request and uses the new revision for the next save", async () => {
    let finish!: (value: ProviderDefaultsSnapshot) => void
    updateEffort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await choose("深入思考")
    await advance()
    expect(button("交给模型")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("#provider-default-model")?.disabled).toBe(
      true
    )
    await advance(1000)
    expect(updateEffort).toHaveBeenCalledOnce()
    await act(async () => finish({ ...initial, effort: "high", revision: "next" }))
    await choose("交给模型")
    await advance()
    expect(updateEffort).toHaveBeenLastCalledWith({ effort: null, expectedRevision: "next" })
    expect(updateEffort).toHaveBeenCalledTimes(2)
  })

  it("rolls back failed changes, does not retry automatically, and allows a fresh read", async () => {
    updateEffort.mockRejectedValueOnce(new Error("设置已被修改，请重新读取"))
    await render()
    await choose("深入思考")
    await advance()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重新读取")
    expect(button("轻量思考")?.getAttribute("aria-pressed")).toBe("true")
    await advance(2000)
    expect(updateEffort).toHaveBeenCalledOnce()
    snapshot.mockResolvedValue({ ...initial, revision: "refreshed" })
    await choose("重新读取")
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await choose("深入思考")
    await advance()
    expect(updateEffort).toHaveBeenLastCalledWith({ effort: "high", expectedRevision: "refreshed" })
  })

  it("shows active-work rejection as a toast and restores the actual saved choice", async () => {
    const message = "当前有任务正在运行。请等待任务结束或停止任务后，再修改该设置。"
    updateEffort.mockRejectedValueOnce(new Error(message))
    await render()
    await choose("深入思考")
    await advance()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(message)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(button("轻量思考")?.getAttribute("aria-pressed")).toBe("true")
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("keeps the saved choice when the parent list cannot refresh", async () => {
    onChanged.mockRejectedValueOnce(new Error("列表读取失败"))
    await render()
    await choose("深入思考")
    await advance()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "设置已保存，但列表刷新失败"
    )
    expect(button("深入思考")?.getAttribute("aria-pressed")).toBe("true")
    await choose("交给模型")
    await advance()
    expect(updateEffort).toHaveBeenLastCalledWith({ effort: null, expectedRevision: "next" })
  })

  it("keeps controls disabled until the parent has finished refreshing", async () => {
    let finish!: () => void
    onChanged.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await render()
    await choose("深入思考")
    await advance()
    expect(button("交给模型")?.disabled).toBe(true)
    await act(async () => finish())
    expect(button("交给模型")?.disabled).toBe(false)
  })

  it("flushes the final pending choice once when leaving the settings", async () => {
    await render()
    await choose("深入思考")
    await act(async () => {
      root!.unmount()
      root = null
    })
    expect(updateEffort).toHaveBeenCalledExactlyOnceWith({
      effort: "high",
      expectedRevision: "original",
    })
    await advance(1000)
    expect(updateEffort).toHaveBeenCalledOnce()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("reports a failed final save even after leaving settings", async () => {
    updateEffort.mockRejectedValueOnce(new Error("网络不可用"))
    await render()
    await choose("深入思考")
    await act(async () => {
      root!.unmount()
      root = null
    })
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith("网络不可用")
  })

  it("waits for a save from the previous mount before reading defaults again", async () => {
    let finish!: (value: ProviderDefaultsSnapshot) => void
    updateEffort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await choose("深入思考")
    await act(async () => {
      root!.unmount()
      root = createRoot(container)
    })
    await render()
    expect(button("轻量思考")).toBeUndefined()
    const saved = { ...initial, effort: "high", revision: "next" }
    snapshot.mockResolvedValue(saved)
    await act(async () => finish(saved))
    expect(button("深入思考")?.getAttribute("aria-pressed")).toBe("true")
    await choose("轻量思考")
    await advance()
    expect(updateEffort).toHaveBeenLastCalledWith({ effort: "low", expectedRevision: "next" })
  })

  it.each(["effort", "model"])(
    "rereads actual defaults when the %s API rejects after writing",
    async (kind) => {
      const models = [...initial.models, { ...initial.models[0]!, id: "model-b", label: "Model B" }]
      let actual = { ...initial, models }
      snapshot.mockImplementation(async () => actual)
      updateEffort.mockImplementationOnce(async () => {
        actual = { ...actual, effort: "high", revision: "next" }
        throw new Error("写入后的读取失败")
      })
      setDefaultModel.mockImplementationOnce(async () => {
        actual = { ...actual, model: "model-b", revision: "next" }
        throw new Error("写入后的读取失败")
      })
      await render()
      if (kind === "effort") await choose("深入思考")
      else {
        await act(async () =>
          container.querySelector<HTMLButtonElement>("#provider-default-model")!.click()
        )
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (node) => node.textContent === "Model B"
        )!
        await act(async () => option.click())
      }
      await advance()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("写入后的读取失败")
      if (kind === "effort") expect(button("深入思考")?.getAttribute("aria-pressed")).toBe("true")
      else expect(container.querySelector("p")?.textContent).not.toBe("Model A")
      expect(container.textContent).toContain(kind === "effort" ? "Model A" : "Model B")
    }
  )

  it("does not show unconfirmed old defaults if a rejected write cannot be reread", async () => {
    updateEffort.mockRejectedValueOnce(new Error("读取失败"))
    snapshot.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("仍无法读取"))
    await render()
    await choose("深入思考")
    await advance()
    expect(container.querySelector("#provider-default-model")).toBeNull()
    expect(button("重新读取")).toBeDefined()
  })

  it("retains a reread action if active work rejects the save and recovery cannot read", async () => {
    updateEffort.mockRejectedValueOnce(new Error("当前有任务正在运行，请稍后重试"))
    snapshot.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("读取失败"))
    await render()
    await choose("深入思考")
    await advance()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(button("重新读取")).toBeDefined()
  })

  it("synchronizes global defaults after a manual recovery read", async () => {
    updateEffort.mockRejectedValueOnce(new Error("无法确认写入结果"))
    snapshot.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("读取失败"))
    await render()
    await choose("深入思考")
    await advance()
    const models = [{ ...initial.models[0]!, id: "model-b", label: "Model B" }]
    snapshot.mockResolvedValue({ ...initial, models, model: "model-b", revision: "latest" })
    await choose("重新读取")
    expect(container.textContent).toContain("Model B")
    expect(mocks.setState).toHaveBeenLastCalledWith({
      models,
      defaultModel: "model-b",
      defaultProvider: "test",
    })
  })

  it.each([{ models: initial.models }, { models: [] }])(
    "does not autosave an unconfigured default: %j",
    async ({ models }) => {
      snapshot.mockResolvedValue({
        ...initial,
        provider: null,
        model: null,
        effort: null,
        disabled: true,
        models,
      })
      await render()
      await advance()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(button("保存")).toBeUndefined()
      expect(button("取消")).toBeUndefined()
      expect(updateEffort).not.toHaveBeenCalled()
      expect(setDefaultModel).not.toHaveBeenCalled()
    }
  )

  it("shows all declared input types as labelled icons", async () => {
    snapshot.mockResolvedValue({
      ...initial,
      models: [
        { ...initial.models[0]!, inputModalities: ["text", "image", "video", "audio", "pdf"] },
      ],
    })
    await render()
    for (const label of ["文本", "图片", "视频", "音频", "PDF"]) {
      expect(container.querySelector(`[aria-label="支持${label}输入"]`)).not.toBeNull()
    }
  })

  it.each([
    { inputModalities: undefined, inputCapabilities: { image: "unknown" as const } },
    { inputModalities: ["text", "image"], inputCapabilities: { image: "unsupported" as const } },
  ])(
    "does not invent multimodal support or override an explicit denial: %j",
    async (capabilities) => {
      snapshot.mockResolvedValue({
        ...initial,
        models: [{ ...initial.models[0]!, ...capabilities }],
      })
      await render()
      expect(container.querySelector('[aria-label="支持文本输入"]')).not.toBeNull()
      expect(container.querySelector('[aria-label="支持图片输入"]')).toBeNull()
      expect(container.querySelector('[aria-label="支持视频输入"]')).toBeNull()
    }
  )

  it("keeps model details independent from thinking and performs no write when expanded", async () => {
    await render()
    await choose("模型详情")
    expect(button("模型详情")?.getAttribute("aria-expanded")).toBe("true")
    expect(container.querySelector("dl")?.textContent).toContain("128,000 Token")
    expect(container.querySelector("dl")?.textContent).toContain(initial.fastModeReason)
    await advance()
    expect(updateEffort).not.toHaveBeenCalled()
  })

  it("does not show thinking controls for a model without declared tiers", async () => {
    snapshot.mockResolvedValue({
      ...initial,
      models: [{ ...initial.models[0]!, reasoningEfforts: [] }],
    })
    await render()
    expect(container.querySelector('[data-slot="toggle-group"]')).toBeNull()
  })

  it.each([
    { trigger: "provider-default-model", label: "Model B", provider: "test", model: "model-b" },
    {
      trigger: "provider-default-provider",
      label: "Other Provider",
      provider: "other",
      model: "model-c",
    },
  ])(
    "autosaves a changed model/provider through the model API: $trigger",
    async ({ trigger, label, provider, model }) => {
      const models = [
        ...initial.models,
        { ...initial.models[0]!, id: "model-b", label: "Model B", reasoningEfforts: [] },
        {
          ...initial.models[0]!,
          id: "model-c",
          providerName: "other",
          provider: "Other Provider",
          reasoningEfforts: ["medium"],
        },
      ]
      snapshot.mockResolvedValue({ ...initial, models })
      setDefaultModel.mockImplementationOnce(async (input) => {
        snapshot.mockResolvedValue({
          ...initial,
          models,
          ...input,
          disabled: false,
          revision: "next",
        })
        return { models, defaultModel: input.model, defaultProvider: input.provider }
      })
      await render()
      await act(async () => container.querySelector<HTMLButtonElement>(`#${trigger}`)!.click())
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (node) => node.textContent === label
      )!
      expect(option).toBeDefined()
      await act(async () => option.click())
      await advance()
      expect(setDefaultModel).toHaveBeenCalledExactlyOnceWith({ provider, model, effort: "" })
      expect(updateEffort).not.toHaveBeenCalled()
      expect(mocks.setState).toHaveBeenCalledWith({
        models,
        defaultModel: model,
        defaultProvider: provider,
      })
    }
  )

  it("requires a fresh read instead of showing stale defaults if the model saved but its snapshot failed", async () => {
    const models = [...initial.models, { ...initial.models[0]!, id: "model-b", label: "Model B" }]
    snapshot
      .mockResolvedValueOnce({ ...initial, models })
      .mockRejectedValueOnce(new Error("读取失败"))
    setDefaultModel.mockResolvedValueOnce({
      models,
      defaultModel: "model-b",
      defaultProvider: "test",
    })
    await render()
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#provider-default-model")!.click()
    )
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === "Model B"
    )!
    await act(async () => option.click())
    await advance()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "默认模型已保存，但重新读取失败"
    )
    expect(container.querySelector("#provider-default-model")).toBeNull()
    snapshot.mockResolvedValue({ ...initial, models, model: "model-b", revision: "refreshed" })
    await choose("重新读取")
    expect(container.textContent).toContain("Model B")
    expect(setDefaultModel).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
