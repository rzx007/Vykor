// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"

import {
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  clampSidebarWidthPx,
  persistSidebarWidthPx,
  readStoredSidebarWidthPx,
  resolveSidebarDefaultWidthPx,
  shouldPersistSidebarWidth,
} from "./sidebar-width"

const STORAGE_KEY = "vykor.desktop.workspace-sidebar-width-px"

beforeEach(() => {
  window.localStorage.clear()
})

describe("clampSidebarWidthPx", () => {
  it("clamps below the minimum", () => {
    expect(clampSidebarWidthPx(100)).toBe(SIDEBAR_MIN_WIDTH_PX)
  })

  it("clamps above the maximum", () => {
    expect(clampSidebarWidthPx(9999)).toBe(SIDEBAR_MAX_WIDTH_PX)
  })

  it("rounds to an integer pixel", () => {
    expect(clampSidebarWidthPx(320.6)).toBe(321)
  })

  it("falls back to the default for non-finite input", () => {
    expect(clampSidebarWidthPx(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH_PX)
  })
})

describe("readStoredSidebarWidthPx", () => {
  it("returns null when nothing is stored", () => {
    expect(readStoredSidebarWidthPx()).toBeNull()
  })

  it("reads and clamps a stored pixel value", () => {
    window.localStorage.setItem(STORAGE_KEY, "312")
    expect(readStoredSidebarWidthPx()).toBe(312)
  })

  it("ignores invalid values", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number")
    expect(readStoredSidebarWidthPx()).toBeNull()
    window.localStorage.setItem(STORAGE_KEY, "-5")
    expect(readStoredSidebarWidthPx()).toBeNull()
  })
})

describe("persistSidebarWidthPx", () => {
  it("writes a raw decimal string", () => {
    persistSidebarWidthPx(312.4)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("312")
  })
})

describe("resolveSidebarDefaultWidthPx", () => {
  it("uses the stored value when present", () => {
    window.localStorage.setItem(STORAGE_KEY, "300")
    expect(resolveSidebarDefaultWidthPx()).toBe(300)
  })

  it("falls back to the default", () => {
    expect(resolveSidebarDefaultWidthPx()).toBe(SIDEBAR_DEFAULT_WIDTH_PX)
  })
})

describe("shouldPersistSidebarWidth", () => {
  it("persists only for user interactions with a positive width", () => {
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, 312)).toBe(true)
    expect(shouldPersistSidebarWidth({ isUserInteraction: false }, 312)).toBe(false)
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, 0)).toBe(false)
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, Number.NaN)).toBe(false)
  })
})
