// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildAnnotationScript } from "./browser-annotation-script"
import type {
  PageAnnotationCommand,
  PageAnnotationSnapshot,
} from "../../../shared/browser-annotation"

function run(command: PageAnnotationCommand): PageAnnotationSnapshot {
  return window.eval(buildAnnotationScript(command))
}
function point(element: Element): void {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element })
}
const rect = {
  x: 10,
  y: 20,
  left: 10,
  top: 20,
  right: 90,
  bottom: 50,
  width: 80,
  height: 30,
  toJSON() {
    return {}
  },
}
beforeEach(() => {
  document.body.innerHTML =
    '<button id="target">提交</button><div><button>同名</button><button>同名</button></div>'
  vi.stubGlobal("requestAnimationFrame", () => 1)
  vi.stubGlobal("cancelAnimationFrame", () => {})
  vi.stubGlobal("CSS", { escape: (value: string) => value })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect)
})
afterEach(() => {
  run({ action: "stop", interactionVersion: 100 })
  Reflect.deleteProperty(window, "__vykorAnnotations")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("page annotation selection", () => {
  it("locks the clicked element without running its pointerdown or click handlers", () => {
    const target = document.querySelector("#target")!
    let actions = 0
    target.addEventListener("pointerdown", () => actions++)
    target.addEventListener("click", () => actions++)
    point(target)
    run({ action: "install", mode: "pick", interactionVersion: 1 })
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
    )
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
    )
    const state = run({ action: "read", interactionVersion: 1 })
    expect(actions).toBe(0)
    expect(state.selected).toMatchObject({
      selector: "#target",
      name: "提交",
      locatorKind: "unique-id",
    })
    expect(state.eventSequence).toBe(1)
    expect(document.querySelectorAll("button")).toHaveLength(3)
  })
  it("does not prevent native wheel events", () => {
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
  it("uses an editable field's label without collecting its default input text", () => {
    document.body.innerHTML =
      '<label for="notes">备注</label><textarea id="notes">TOP_SECRET_12345</textarea>'
    const element = document.querySelector("textarea")!
    point(element)
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 2 }).selected!
    expect(selected.name).toBe("备注")
    expect(JSON.stringify(selected)).not.toContain("TOP_SECRET_12345")
  })
  it("uses a semantic attribute to recover a target after document structure changes", () => {
    document.body.innerHTML =
      '<section><button>同名</button><button data-testid="save-button">同名</button></section>'
    const target = document.querySelector('[data-testid="save-button"]')!
    point(target)
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 2 }).selected!
    expect(selected.selector).toContain("data-testid")
    expect(selected.selector).not.toContain(":nth-")
    run({ action: "syncMarkers", interactionVersion: 2, markers: [{ ...selected, id: "a-1" }] })
    document.querySelector("section")!.replaceWith(
      Object.assign(document.createElement("article"), {
        innerHTML: '<div>新增内容</div><button data-testid="save-button">同名</button>',
      })
    )
    expect(run({ action: "read", interactionVersion: 2 }).markers[0].status).toBe("visible")
  })
  it("does not use private data attributes as selector anchors", () => {
    document.body.innerHTML =
      '<div><button data-token="private-secret-value">同名</button><button>同名</button></div>'
    const element = document.querySelector("button")!
    point(element)
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 2 }).selected!
    expect(JSON.stringify(selected)).not.toContain("private-secret-value")
    expect(selected.selector).not.toContain("data-token")
    expect(selected.locatorKind).toBe("path")
  })
  it("does not restore a semantic anchor when it becomes ambiguous or changes identity", () => {
    document.body.innerHTML = '<button data-testid="save-button">提交</button>'
    const element = document.querySelector("button")!
    point(element)
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 2 }).selected!
    run({ action: "syncMarkers", interactionVersion: 2, markers: [{ ...selected, id: "a-1" }] })
    element.remove()
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button data-testid="save-button">提交</button><button data-testid="save-button">提交</button>'
    )
    expect(run({ action: "read", interactionVersion: 2 }).markers[0].status).toBe("missing")
    document.querySelectorAll("[data-testid]")[1].remove()
    document.querySelector("[data-testid]")!.textContent = "删除"
    expect(run({ action: "read", interactionVersion: 2 }).markers[0].status).toBe("missing")
  })
  it("leaves Escape available to the website when merely displaying saved markers", () => {
    run({ action: "install", mode: "review", interactionVersion: 2 })
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
  it("highlights the saved target when hovering its pin and opens that pin once", () => {
    const target = document.querySelector("#target")!
    point(target)
    run({ action: "install", mode: "pick", interactionVersion: 2 })
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 2 }).selected!
    run({ action: "syncMarkers", interactionVersion: 2, markers: [{ ...selected, id: "a-1" }] })
    const root = document.querySelector<HTMLElement>("[data-vykor-annotations]")!
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({ ...rect, width: 800, height: 600 }),
    })
    point(root)
    const pin = root.shadowRoot!.querySelector("button")!
    pin.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }))
    run({ action: "read", interactionVersion: 2 })
    expect(root.shadowRoot!.querySelector<HTMLElement>(".frame")!.style.width).toBe("80px")
    pin.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }))
    expect(run({ action: "read", interactionVersion: 2 }).focusedAnnotationId).toBe("a-1")
  })
  it("does not reattach a structural path to a replacement with identical text", () => {
    const target = document.querySelectorAll("div button")[1]!
    point(target)
    run({ action: "install", mode: "pick", interactionVersion: 3 })
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const selected = run({ action: "read", interactionVersion: 3 }).selected!
    run({ action: "syncMarkers", interactionVersion: 3, markers: [{ ...selected, id: "a-1" }] })
    target.replaceWith(Object.assign(document.createElement("button"), { textContent: "同名" }))
    expect(run({ action: "read", interactionVersion: 3 }).markers).toEqual([
      { id: "a-1", status: "missing", rect: null },
    ])
    expect(
      run({ action: "validateSelection", interactionVersion: 3, handleId: selected.handleId })
        .selected
    ).toBeNull()
  })
  it("ignores stale installs and stops without removing the current selection layer", () => {
    run({ action: "install", mode: "pick", interactionVersion: 5 })
    run({ action: "install", mode: "review", interactionVersion: 4 })
    run({ action: "stop", interactionVersion: 4 })
    expect(run({ action: "read", interactionVersion: 5 }).mode).toBe("pick")
    expect(document.querySelectorAll("[data-vykor-annotations]")).toHaveLength(1)
    run({ action: "stop", interactionVersion: 6 })
    const target = document.querySelector("#target")!
    let clicks = 0
    target.addEventListener("click", () => clicks++)
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(clicks).toBe(1)
    expect(document.querySelector("[data-vykor-annotations]")).toBeNull()
  })
})
