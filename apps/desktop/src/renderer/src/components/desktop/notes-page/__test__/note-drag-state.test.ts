import { describe, expect, it } from "vitest"
import { createNoteDragMachine, exceedsDragDistance, outsideFolder } from "../note-drag-state"

describe("note drag thresholds", () => {
  it("uses Euclidean activation and exit distances at the inclusive boundary", () => {
    expect(exceedsDragDistance({ x: 0, y: 0 }, { x: 5.9, y: 0 })).toBe(false)
    expect(exceedsDragDistance({ x: 0, y: 0 }, { x: 3.6, y: 4.8 })).toBe(true)
    const rect = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(outsideFolder({ x: 123.9, y: 50 }, rect)).toBe(false)
    expect(outsideFolder({ x: 124, y: 50 }, rect)).toBe(true)
  })
  it("merges only after a continuous 250ms hover and resets on target changes", () => {
    const machine = createNoteDragMachine()
    machine.start()
    expect(machine.enter({ type: "note", id: "a" }, 0)).toMatchObject({ changed: true, delay: 250 })
    expect(machine.enter({ type: "note", id: "a" }, 100)).toMatchObject({
      changed: false,
      delay: 150,
    })
    expect(machine.tick(249).intent.type).toBe("hover-note")
    expect(machine.tick(250).intent).toEqual({ type: "merge", noteId: "a" })
    machine.enter({ type: "note", id: "b" }, 251)
    expect(machine.tick(500).intent.type).toBe("hover-note")
    machine.enter(null, 501)
    expect(machine.tick(1000).intent.type).toBe("sort")
  })
  it("opens folders at 400ms and clears hover on scroll and cancellation", () => {
    const machine = createNoteDragMachine()
    machine.start()
    machine.enter({ type: "folder", id: "f1" }, 10)
    expect(machine.tick(409).intent.type).toBe("hover-folder")
    expect(machine.tick(410).intent.type).toBe("open-folder")
    machine.scroll()
    expect(machine.tick(900).intent.type).toBe("sort")
    machine.enter({ type: "note", id: "a" }, 900)
    machine.cancel()
    expect(machine.tick(2000).intent.type).toBe("sort")
  })
  it("does not delay explicit keyboard intentions", () => {
    const machine = createNoteDragMachine()
    machine.start({ keyboard: true })
    expect(machine.enter({ type: "folder", id: "f1" }, 0).intent.type).toBe("open-folder")
    expect(machine.enter({ type: "note", id: "a" }, 1)).toMatchObject({
      intent: { type: "sort" },
      delay: null,
    })
    expect(machine.merge("b")).toBe(false)
    expect(machine.merge("a")).toBe(true)
    expect(machine.enter({ type: "note", id: "a" }, 2).intent).toEqual({
      type: "merge",
      noteId: "a",
    })
    machine.enter({ type: "note", id: "b" }, 3)
    expect(machine.intent.type).toBe("sort")
  })
})
