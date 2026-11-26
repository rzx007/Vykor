// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { InteractiveUiControl } from "../interactive-ui-control"

it("updates the rich-content switch without changing the generation preference", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const initial = Promise.withResolvers<boolean>()
  let publishRich: (enabled: boolean) => void = () => {}
  const unsubscribeRich = vi.fn()
  const updateInteractiveUiEnabled = vi.fn()
  const updateRichUiEnabled = vi.fn(async (enabled: boolean) => {
    publishRich(enabled)
    return enabled
  })
  vi.stubGlobal("desktop", {
    settings: {
      getInteractiveUiEnabled: async () => true,
      onInteractiveUiEnabledChanged: () => () => {},
      updateInteractiveUiEnabled,
      getRichUiEnabled: () => initial.promise,
      onRichUiEnabledChanged: (listener: typeof publishRich) => {
        publishRich = listener
        return unsubscribeRich
      },
      updateRichUiEnabled,
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <>
          <InteractiveUiControl />
          <InteractiveUiControl preference="rich" />
        </>
      )
    )
    const [generation, rich] = host.querySelectorAll<HTMLElement>('[role="switch"]')
    expect(generation.getAttribute("aria-checked")).toBe("true")
    expect(rich.getAttribute("aria-disabled")).toBe("true")

    await act(async () => {
      publishRich(false)
      initial.resolve(true)
    })
    expect(rich.getAttribute("aria-checked")).toBe("false")

    await act(async () => rich.click())
    expect(updateRichUiEnabled).toHaveBeenCalledExactlyOnceWith(true)
    expect(updateInteractiveUiEnabled).not.toHaveBeenCalled()
    expect(rich.getAttribute("aria-checked")).toBe("true")
    expect(generation.getAttribute("aria-checked")).toBe("true")

    updateRichUiEnabled.mockRejectedValueOnce(new Error("写入失败"))
    await act(async () => rich.click())
    expect(rich.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("写入失败")
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
  expect(unsubscribeRich).toHaveBeenCalledOnce()
})
