// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"

import { createPanelWidthStore, shouldPersistPanelWidth } from "./panel-width-store"

beforeEach(() => {
  window.localStorage.clear()
})

describe("createPanelWidthStore", () => {
  const store = createPanelWidthStore({
    storageKey: "test.panel-width-px",
    defaultPx: 300,
    minPx: 200,
    maxPx: 500,
  })

  it("clamps and rounds", () => {
    expect(store.clamp(100)).toBe(200)
    expect(store.clamp(900)).toBe(500)
    expect(store.clamp(320.6)).toBe(321)
    expect(store.clamp(Number.NaN)).toBe(300)
  })

  it("reads and persists raw decimal strings", () => {
    expect(store.read()).toBeNull()
    store.persist(320.4)
    expect(window.localStorage.getItem("test.panel-width-px")).toBe("320")
    expect(store.read()).toBe(320)
  })

  it("ignores invalid stored values and resolves the default", () => {
    window.localStorage.setItem("test.panel-width-px", "nope")
    expect(store.read()).toBeNull()
    expect(store.resolveDefault()).toBe(300)
  })
})

describe("shouldPersistPanelWidth", () => {
  it("requires a user interaction and a width above 1px", () => {
    expect(shouldPersistPanelWidth({ isUserInteraction: true }, 312)).toBe(true)
    expect(shouldPersistPanelWidth({ isUserInteraction: false }, 312)).toBe(false)
    expect(shouldPersistPanelWidth({ isUserInteraction: true }, 1)).toBe(false)
  })
})
