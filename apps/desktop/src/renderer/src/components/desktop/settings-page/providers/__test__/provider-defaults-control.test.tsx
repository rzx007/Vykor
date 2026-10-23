// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"
const toastError = vi.hoisted(() => vi.fn())
vi.mock("@renderer/lib/toast", () => ({ toast: { error: toastError, success: vi.fn() } }))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { setState: vi.fn() },
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
      inputCapabilities: { image: "native" },
    },
  ],
}
describe("friendly model defaults", () => {
  let container: HTMLDivElement, root: Root
  const snapshot = vi.fn(async () => initial)
  const updateEffort = vi.fn(async (input: { effort: string | null }) => ({
    ...initial,
    effort: input.effort,
    revision: "next",
  }))
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    snapshot.mockReset().mockResolvedValue(initial)
    updateEffort
      .mockReset()
      .mockImplementation(async (input) => ({ ...initial, effort: input.effort, revision: "next" }))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { providerDefaults: { snapshot, updateEffort } },
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const render = () =>
    act(async () => root.render(<ProviderDefaultsControl onChanged={async () => {}} />))
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!
  it("shows the model and supported friendly options without inventing tiers", async () => {
    await render()
    expect(container.textContent).toContain("Model A")
    expect(container.textContent).toContain("Test Provider")
    expect(button("轻量思考").getAttribute("aria-pressed")).toBe("true")
    expect(button("深入思考")).toBeDefined()
    expect(button("适度思考")).toBeUndefined()
    expect(container.textContent).toContain("可读图片")
    expect(button("模型详情").getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("不发送强度参数")
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
    expect(button("已是默认")).toBeUndefined()
  })
  it("opens model details separately without changing or saving the thinking choice", async () => {
    await render()
    expect(container.querySelector("dl")).toBeNull()
    await act(async () => button("模型详情").click())
    expect(button("模型详情").getAttribute("aria-expanded")).toBe("true")
    const details = container.querySelector('[role="region"]')!
    expect(details.textContent).toContain("128,000 Token")
    expect(details.textContent).toContain(initial.fastModeReason)
    expect(details.closest('[data-slot="collapsible"]')?.contains(button("轻量思考"))).toBe(false)
    expect(button("轻量思考").getAttribute("aria-pressed")).toBe("true")
    expect(button("保存")).toBeUndefined()
    expect(updateEffort).not.toHaveBeenCalled()
    await act(async () => button("模型详情").click())
    expect(button("模型详情").getAttribute("aria-expanded")).toBe("false")
  })
  it("can cancel a changed thinking choice without a request", async () => {
    await render()
    await act(async () => button("深入思考").click())
    expect(button("取消")).toBeDefined()
    expect(container.textContent).toContain("待保存")
    await act(async () => button("取消").click())
    expect(button("轻量思考").getAttribute("aria-pressed")).toBe("true")
    expect(button("保存")).toBeUndefined()
    expect(button("取消")).toBeUndefined()
    expect(updateEffort).not.toHaveBeenCalled()
  })
  it.each([{ models: initial.models }, { models: [] }])(
    "does not offer draft actions before choosing a disabled default: %j",
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
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).toContain("选择默认模型")
      expect(button("取消")).toBeUndefined()
      expect(button("保存")).toBeUndefined()
      expect(updateEffort).not.toHaveBeenCalled()
    }
  )
  it("does not isolate intrinsic width for the compact card controls", async () => {
    await render()
    const controls = container.querySelector("#provider-default-model")!
    expect(controls.closest('[data-slot="field-group"]')).toBeNull()
    expect(
      container.querySelector('[data-slot="toggle-group"]')?.closest('[data-slot="field-group"]')
    ).toBeNull()
  })
  it("maps friendly selections to the original API values and checks revisions", async () => {
    await render()
    await act(async () => button("深入思考").click())
    expect(updateEffort).not.toHaveBeenCalled()
    await act(async () => button("保存").click())
    expect(updateEffort).toHaveBeenCalledWith({ effort: "high", expectedRevision: "original" })
    expect(button("深入思考").getAttribute("aria-pressed")).toBe("true")
  })
  it("uses no explicit effort when leaving the choice to the model", async () => {
    await render()
    await act(async () => button("交给模型").click())
    await act(async () => button("保存").click())
    expect(updateEffort).toHaveBeenCalledWith({ effort: null, expectedRevision: "original" })
  })
  it("locks draft actions while saving and removes the save bar after success", async () => {
    let finish!: (value: ProviderDefaultsSnapshot) => void
    updateEffort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await act(async () => button("深入思考").click())
    await act(async () => button("保存").click())
    expect(button("保存中…").disabled).toBe(true)
    expect(button("取消").disabled).toBe(true)
    expect(button("交给模型").disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("#provider-default-model")?.disabled).toBe(
      true
    )
    await act(async () => finish({ ...initial, effort: "high", revision: "next" }))
    expect(button("深入思考").getAttribute("aria-pressed")).toBe("true")
    expect(button("取消")).toBeUndefined()
    expect(button("保存")).toBeUndefined()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it("retains the draft without claiming it is saved after a rejected update", async () => {
    updateEffort.mockRejectedValue(new Error("设置已被修改，请重新读取"))
    await render()
    await act(async () => button("深入思考").click())
    await act(async () => button("保存").click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重新读取")
    expect(button("深入思考").getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).toContain("待保存")
    await act(async () => button("取消").click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(button("轻量思考").getAttribute("aria-pressed")).toBe("true")
  })
  it("shows an active-work save warning as the shared toast", async () => {
    const message = "当前有任务正在运行。请等待任务结束或停止任务后，再修改该设置。"
    updateEffort.mockRejectedValue(new Error(message))
    await render()
    await act(async () => button("深入思考").click())
    await act(async () => button("保存").click())
    expect(toastError).toHaveBeenCalledWith(message)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain("待保存")
  })
  it("does not show a working effort control when the model has no declared tiers", async () => {
    snapshot.mockResolvedValue({
      ...initial,
      models: [{ ...initial.models[0]!, reasoningEfforts: [] }],
    })
    await render()
    expect(container.querySelector('[data-slot="toggle-group"]')).toBeNull()
    await act(async () => button("模型详情").click())
    expect(container.textContent).toContain("服务未提供可调选项")
  })
})
