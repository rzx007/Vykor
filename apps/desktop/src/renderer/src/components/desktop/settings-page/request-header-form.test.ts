import { describe, expect, it } from "vitest"

import { headersFromRows, rowsFromHeaders } from "./request-header-form"

describe("headersFromRows", () => {
  it("preserves template text and reports incomplete rows", () => {
    expect(headersFromRows([{ key: "1", name: " X-Session ", value: " {{sessionId}} " }])).toEqual({
      ok: true,
      headers: { "X-Session": "{{sessionId}}" },
    })

    expect(headersFromRows([{ key: "1", name: "X-Session", value: "" }])).toEqual({
      ok: false,
      message: "请求头名称和值需要同时填写。",
    })
  })

  it("returns an explicit empty object when every row is removed", () => {
    expect(headersFromRows([])).toEqual({ ok: true, headers: {} })
  })
})

describe("rowsFromHeaders", () => {
  it("maps saved headers into editable rows", () => {
    expect(
      rowsFromHeaders({ "X-Session": "{{sessionId}}", "User-Agent": "{{userAgent}}" })
    ).toEqual([
      { key: "header-0", name: "X-Session", value: "{{sessionId}}" },
      { key: "header-1", name: "User-Agent", value: "{{userAgent}}" },
    ])
    expect(rowsFromHeaders()).toEqual([])
  })
})
