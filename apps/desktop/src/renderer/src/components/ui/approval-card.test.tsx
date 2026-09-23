// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import ApprovalCard from "./approval-card"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("keeps the footer fixed and requires an explicit submit on the last radio question", async () => {
  const onSubmitted = vi.fn()
  await act(async () => {
    root.render(
      <ApprovalCard
        questions={[{ q: "Confirm?", type: "radio", options: ["Yes", "No"] }]}
        labels={{ send: "提交" }}
        dismissible={false}
        onSubmitted={onSubmitted}
      />
    )
  })

  const yes = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Yes"
  )
  await act(async () => {
    yes?.click()
    await new Promise((resolve) => setTimeout(resolve, 520))
  })
  expect(onSubmitted).not.toHaveBeenCalled()

  const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "提交"
  )
  expect(submit?.disabled).toBe(false)
  expect(container.querySelector(".shrink-0.border-t")).not.toBeNull()
  expect(container.querySelector(".overflow-y-auto")).not.toBeNull()
  await act(async () => submit?.click())
  expect(onSubmitted).toHaveBeenCalledTimes(1)
})

it("collects multiple checked options and submits them together", async () => {
  const onSubmitted = vi.fn()
  await act(async () => {
    root.render(
      <ApprovalCard
        questions={[{ q: "Select features", type: "check", options: ["A", "B", "C"] }]}
        labels={{ send: "提交" }}
        dismissible={false}
        onSubmitted={onSubmitted}
      />
    )
  })

  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
  await act(async () => {
    buttons.find((button) => button.textContent === "A")?.click()
    buttons.find((button) => button.textContent === "C")?.click()
  })
  expect(onSubmitted).not.toHaveBeenCalled()

  await act(async () => {
    ;[...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "提交")
      ?.click()
  })
  expect(onSubmitted).toHaveBeenCalledWith({ selected: { 0: [0, 2] }, custom: {} })
})
