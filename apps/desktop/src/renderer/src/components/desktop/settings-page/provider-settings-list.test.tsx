// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopProviderInfo } from "@shared/provider-types"
vi.mock("./provider-brand-icons", () => ({ resolveProviderBrandIcon: () => undefined }))
import { ProviderListCard } from "./provider-settings-list"

const provider: DesktopProviderInfo = {
  name: "test",
  displayName: "Test Service",
  connected: true,
  active: false,
  local: false,
  credentialSource: "credentials",
  custom: true,
  source: "custom",
  baseUrl: "https://example.invalid",
  models: [{ id: "model", label: "Model" }],
}
describe("beUI provider overflow actions", () => {
  let container: HTMLDivElement, root: Root
  const onTest = vi.fn(),
    onConnect = vi.fn(),
    onRemoveCustom = vi.fn(),
    onEditCustom = vi.fn()
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    for (const handler of [onTest, onConnect, onRemoveCustom, onEditCustom]) handler.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const render = (busyProvider: string | null = null) =>
    act(async () =>
      root.render(
        <ProviderListCard
          connectedProviders={[provider]}
          availableProviders={[]}
          additionalProviderCount={0}
          busyProvider={busyProvider}
          onShowMore={vi.fn()}
          onConnect={onConnect}
          onDisconnect={vi.fn()}
          onAddCustom={vi.fn()}
          onEditCustom={onEditCustom}
          onRemoveCustom={onRemoveCustom}
          verified={{}}
          onTest={onTest}
        />
      )
    )
  const action = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  it("keeps testing and credential updates visible while hiding edit and delete", async () => {
    await render()
    expect(action("测试 Test Service 连接")).not.toBeNull()
    expect(action("更新 Test Service 密钥")).not.toBeNull()
    expect(action("编辑 Test Service")).toBeNull()
    expect(action("删除 Test Service")).toBeNull()
    expect(action("测试 Test Service 连接")?.title).toBe("测试连接")
    expect(action("更新 Test Service 密钥")?.title).toBe("更新密钥")
    expect(action("测试 Test Service 连接")?.querySelector(".sr-only")?.textContent).toBe(
      "测试连接"
    )
    expect(action("更新 Test Service 密钥")?.querySelector(".sr-only")?.textContent).toBe(
      "更新密钥"
    )
    await act(async () => action("测试 Test Service 连接")!.click())
    expect(onTest).toHaveBeenCalledWith(provider)
    expect(onRemoveCustom).not.toHaveBeenCalled()
  })
  it("reveals extra actions only on demand and preserves their original callbacks", async () => {
    await render()
    await act(async () => action("更多 Test Service 操作")!.click())
    expect(action("编辑 Test Service")).not.toBeNull()
    expect(action("删除 Test Service")).not.toBeNull()
    expect(action("删除 Test Service")?.title).toBe("删除")
    await act(async () => action("编辑 Test Service")!.click())
    expect(onEditCustom).toHaveBeenCalledWith(provider)
    expect(onRemoveCustom).not.toHaveBeenCalled()
    expect(action("更多 Test Service 操作")?.getAttribute("aria-expanded")).toBe("false")
  })
  it("disables mutations while a provider operation is in flight", async () => {
    await render("other")
    expect(action("测试 Test Service 连接")?.disabled).toBe(true)
    expect(action("更新 Test Service 密钥")?.disabled).toBe(true)
    await act(async () => action("更新 Test Service 密钥")!.click())
    expect(onConnect).not.toHaveBeenCalled()
  })
})
