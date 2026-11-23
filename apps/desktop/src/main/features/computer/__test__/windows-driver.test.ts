import { describe, expect, it } from "vitest"
import { bindWindowsElements } from "../windows-driver"

const edit = { role: "Document", label: "Text editor", identity: "1,123,4", enabled: true, actions: ["set_value"],
  frame: { x: 1, y: 2, w: 50, h: 60 } }
const raw = { role: "Document", label: "Text editor", value: "line 1\r\nline 2", enabled: true,
  element_token: "cua-token", actions: ["set_value"], frame: edit.frame }

describe("bounded Windows control observation", () => {
  it("uses only native window controls and their values", () => {
    const orphan = { ...raw, label: "A sibling window's control", element_token: "sibling" }
    const native = { ...edit, value: "current window", valueDigest: "full-value-proof" }
    const [bound] = bindWindowsElements([native], [raw, orphan])
    expect(bound).toMatchObject({ identity: edit.identity, value: native.value, valueDigest: native.valueDigest, actions: ["set_value"] })
    expect(bound).not.toHaveProperty("cuaToken")
    expect(bindWindowsElements([native], [raw, orphan])).toHaveLength(1)
  })

  it("omits protected controls and unproved native values, irrespective of Cua data", () => {
    expect(bindWindowsElements([{ ...edit, protected: true }], [raw])).toEqual([])
    for (const rows of [
      [raw, { ...raw, element_token: "other-token" }],
      [{ ...raw, frame: { ...raw.frame, x: raw.frame.x + 7 } }],
    ]) {
      expect(bindWindowsElements([edit], rows)[0]).toMatchObject({ actions: [] })
      expect(bindWindowsElements([edit], rows)[0]?.value).toBeUndefined()
    }
  })

  it("reports empty text only when the Windows ValuePattern confirms it", () => {
    const omitted = { ...raw, value: undefined }
    expect(bindWindowsElements([{ ...edit, value: "", valueDigest: "empty-value-proof" }], [omitted])[0]?.value).toBe("")
    expect(bindWindowsElements([edit], [omitted])[0]?.value).toBeUndefined()
    expect(bindWindowsElements([{ ...edit, value: "" }], [])[0]?.value).toBeUndefined()
  })
})
