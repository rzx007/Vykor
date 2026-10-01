import { describe, expect, it } from "vitest"

import { findComposerTrigger } from "../composer-trigger"

describe("findComposerTrigger", () => {
  it("accepts Chinese command queries without swallowing Chinese punctuation", () => {
    expect(findComposerTrigger("/模型", 3)).toMatchObject({
      sigil: "/",
      query: "模型",
      mode: "leading",
    })
    expect(findComposerTrigger("/压缩，继续", 3)?.query).toBe("压缩")
    expect(findComposerTrigger("/压缩，继续", 4)).toBeNull()
    expect(findComposerTrigger("请用 /代码审查", 8)).toMatchObject({
      query: "代码审查",
      mode: "inline",
    })
  })

  it("finds leading slash and inline slash tokens at the cursor", () => {
    expect(findComposerTrigger("/rev", 4)).toEqual({
      sigil: "/",
      query: "rev",
      from: 0,
      to: 4,
      mode: "leading",
    })
    expect(findComposerTrigger("请用 /wri", 7)).toEqual({
      sigil: "/",
      query: "wri",
      from: 3,
      to: 7,
      mode: "inline",
    })
  })

  it("finds dollar tokens and an empty query", () => {
    expect(findComposerTrigger("请用 $wri", 7)).toEqual({
      sigil: "$",
      query: "wri",
      from: 3,
      to: 7,
      mode: "inline",
    })
    expect(findComposerTrigger("/", 1)).toEqual({
      sigil: "/",
      query: "",
      from: 0,
      to: 1,
      mode: "leading",
    })
  })

  it("returns the whole token when the cursor is in its middle", () => {
    expect(findComposerTrigger("/writing-plans body", 5)).toEqual({
      sigil: "/",
      query: "writing-plans",
      from: 0,
      to: 14,
      mode: "leading",
    })
  })

  it("accepts only ASCII query characters and stops at punctuation", () => {
    expect(findComposerTrigger("/a.b_c:d-9", 10)?.query).toBe("a.b_c:d-9")
    expect(findComposerTrigger("/write, next", 7)).toBeNull()
    expect(findComposerTrigger("/write,", 6)).toEqual({
      sigil: "/",
      query: "write",
      from: 0,
      to: 6,
      mode: "leading",
    })
  })

  it("rejects non-boundary sigils, URLs, doubled sigils, and Chinese punctuation", () => {
    expect(findComposerTrigger("https://x/y", 11)).toBeNull()
    expect(findComposerTrigger("word/name", 9)).toBeNull()
    expect(findComposerTrigger("//rev", 5)).toBeNull()
    expect(findComposerTrigger("$$HOME", 6)).toBeNull()
    expect(findComposerTrigger("请用（/wri", 7)).toBeNull()
  })

  it("requires the cursor to be inside an eligible token", () => {
    expect(findComposerTrigger("hello /rev", 0)).toBeNull()
    expect(findComposerTrigger("hello /rev", 7)).toEqual({
      sigil: "/",
      query: "rev",
      from: 6,
      to: 10,
      mode: "inline",
    })
    expect(findComposerTrigger("hello /rev", 6)).toBeNull()
  })

  it("allows an inline trigger immediately after an atomic composer node", () => {
    expect(findComposerTrigger("$writing-plans/rev", 18, { atomicBoundaries: [14] })).toEqual({
      sigil: "/",
      query: "rev",
      from: 14,
      to: 18,
      mode: "inline",
    })
  })
})
