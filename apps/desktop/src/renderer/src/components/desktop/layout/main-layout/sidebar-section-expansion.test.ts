// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SIDEBAR_SECTION_EXPANSION,
  SIDEBAR_SECTIONS_STORAGE_KEY,
  loadSidebarSectionExpansion,
  parseSidebarSectionExpansion,
  saveSidebarSectionExpansion,
} from "./sidebar-section-expansion"

describe("sidebar-section-expansion", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("returns default values when storage is empty or invalid", () => {
    expect(parseSidebarSectionExpansion(null)).toEqual(DEFAULT_SIDEBAR_SECTION_EXPANSION)
    expect(parseSidebarSectionExpansion("")).toEqual(DEFAULT_SIDEBAR_SECTION_EXPANSION)
    expect(parseSidebarSectionExpansion("invalid-json")).toEqual(DEFAULT_SIDEBAR_SECTION_EXPANSION)
    expect(parseSidebarSectionExpansion("123")).toEqual(DEFAULT_SIDEBAR_SECTION_EXPANSION)
  })

  it("handles partial or corrupt fields by falling back to defaults", () => {
    expect(parseSidebarSectionExpansion(JSON.stringify({ projects: false }))).toEqual({
      projects: false,
      im: true,
      recent: true,
    })
    // 旧数据没有 im 字段 → 默认展开。
    expect(parseSidebarSectionExpansion(JSON.stringify({ recent: false }))).toEqual({
      projects: true,
      im: true,
      recent: false,
    })
    expect(
      parseSidebarSectionExpansion(
        JSON.stringify({ projects: "invalid", im: false, recent: false })
      )
    ).toEqual({
      projects: true,
      im: false,
      recent: false,
    })
  })

  it("saves and loads expansion state from localStorage", () => {
    expect(loadSidebarSectionExpansion()).toEqual({ projects: true, im: true, recent: true })

    saveSidebarSectionExpansion({ projects: false, im: true, recent: true })
    expect(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY)).toBe(
      JSON.stringify({ projects: false, im: true, recent: true })
    )
    expect(loadSidebarSectionExpansion()).toEqual({ projects: false, im: true, recent: true })

    saveSidebarSectionExpansion({ projects: false, im: false, recent: false })
    expect(loadSidebarSectionExpansion()).toEqual({ projects: false, im: false, recent: false })
  })
})
