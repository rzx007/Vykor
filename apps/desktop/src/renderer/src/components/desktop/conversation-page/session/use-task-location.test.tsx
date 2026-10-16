// @vitest-environment jsdom
import { act, Profiler, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it } from "vitest"
import { useTaskLocation } from "./use-task-location"

const container = document.createElement("div")
const root = createRoot(container)
let changeLocation: (value: "default" | "current" | "worktree") => void

function Picker({ projectId }: { projectId: string | null }) {
  const [location, setLocation] = useTaskLocation(projectId)
  useLayoutEffect(() => {
    changeLocation = setLocation
  }, [setLocation])
  return <span>{location}</span>
}

afterEach(() => {
  act(() => root.unmount())
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

it("resets project choices before committing the newly selected project", () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const committed: string[] = []
  const render = (projectId: string | null) =>
    act(() =>
      root.render(
        <Profiler id="picker" onRender={() => committed.push(container.textContent ?? "")}>
          <Picker projectId={projectId} />
        </Profiler>
      )
    )
  render("a")
  act(() => changeLocation("worktree"))
  expect(container.textContent).toBe("worktree")
  committed.length = 0

  render("b")
  expect(committed).toEqual(["default"])
  render("a")
  expect(container.textContent).toBe("default")
  act(() => changeLocation("current"))
  render(null)
  expect(container.textContent).toBe("default")
})
