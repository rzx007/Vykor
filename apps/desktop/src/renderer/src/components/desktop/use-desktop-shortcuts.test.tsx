// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopShortcuts } from "./use-desktop-shortcuts"
import { clearShortcutBinding, resetAllShortcutBindings } from "./desktop-shortcuts"

let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); resetAllShortcutBindings(); container = document.createElement("div"); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); resetAllShortcutBindings(); vi.unstubAllGlobals() })
function Harness() {
  const [count, setCount] = useState(0)
  useDesktopShortcuts({ toggleSidebar: () => setCount((value) => value + 1) })
  return <div><output>{count}</output><div className="desktop-terminal"><input /></div></div>
}
function press(target: EventTarget, isComposing = false) { target.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true, isComposing })) }

it("updates the actual keyboard handler after clearing and restoring a binding", () => {
  act(() => root.render(<Harness />))
  act(() => press(window))
  expect(container.querySelector("output")!.textContent).toBe("1")
  act(() => { clearShortcutBinding("toggleSidebar") })
  act(() => press(window))
  expect(container.querySelector("output")!.textContent).toBe("1")
  act(() => { resetAllShortcutBindings() })
  act(() => press(window))
  expect(container.querySelector("output")!.textContent).toBe("2")
})

it("lets terminal and input-method key events pass without performing an application command", () => {
  act(() => root.render(<Harness />))
  act(() => { press(container.querySelector("input")!); press(window, true) })
  expect(container.querySelector("output")!.textContent).toBe("0")
})
