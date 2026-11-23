// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ComputerAppGrants } from "../computer-app-grants"

it("shows and revokes remembered Computer app permissions", async () => {
  const revokeAppGrant = vi.fn(async () => [])
  vi.stubGlobal("desktop", { computer: {
    supported: true,
    listAppGrants: async () => [{ id: "calc", name: "计算器" }],
    revokeAppGrant,
  } })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ComputerAppGrants />))
    const revoke = container.querySelector<HTMLButtonElement>('[aria-label="撤销 计算器 的访问许可"]')!
    await act(async () => revoke.click())
    expect(revokeAppGrant).toHaveBeenCalledExactlyOnceWith("calc")
    expect(container.textContent).toContain("没有已授权的应用。")
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
