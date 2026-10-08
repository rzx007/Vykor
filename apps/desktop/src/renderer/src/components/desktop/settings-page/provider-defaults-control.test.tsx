// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"
const toastError = vi.hoisted(() => vi.fn())
vi.mock("@renderer/lib/toast", () => ({ toast: { error: toastError } }))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { setState: vi.fn() },
}))
vi.mock("./provider-brand-icons", () => ({ resolveProviderBrandIcon: () => undefined }))
import { ProviderDefaultsControl } from "./provider-defaults-control"

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
    expect(container.querySelector("details")?.open).toBe(false)
    expect(container.textContent).not.toContain("不发送强度参数")
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
    expect(button("已是默认")).toBeUndefined()
  })
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
  it("retains the draft without claiming it is saved after a rejected update", async () => {
    updateEffort.mockRejectedValue(new Error("设置已被修改，请重新读取"))
    await render()
    await act(async () => button("深入思考").click())
    await act(async () => button("保存").click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重新读取")
    expect(button("深入思考").getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).toContain("待保存")
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
    expect(container.textContent).toContain("服务未提供可调选项")
  })
})
