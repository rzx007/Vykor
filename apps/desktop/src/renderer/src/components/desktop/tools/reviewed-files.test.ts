import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  revalidateReviewedFiles,
  reviewFileKey,
  reviewPatchFingerprint,
  useReviewedFiles,
} from "./reviewed-files"

const namespace = {
  scopeId: "session:one",
  rootPath: "D:/repo",
  range: "unstaged",
  ignoreWhitespace: false,
}
beforeEach(() => useReviewedFiles.setState({ marks: {} }))
afterEach(() => vi.unstubAllGlobals())
describe("reviewed files", () => {
  it("restores reviewed fingerprints without persisting source code", async () => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const key = reviewFileKey(namespace, "a.ts"),
      fingerprint = await reviewPatchFingerprint("private source text")
    useReviewedFiles.getState().setReviewed(key, fingerprint, true)
    const saved = values.get("vykor.desktop.reviewed-files")!
    expect(saved).not.toContain("private source text")
    useReviewedFiles.setState({ marks: {} })
    values.set("vykor.desktop.reviewed-files", saved)
    await useReviewedFiles.persist.rehydrate()
    expect(useReviewedFiles.getState().marks[key]).toBe(fingerprint)
  })
  it("invalidates equal-length patches when their contents change", async () => {
    const key = reviewFileKey(namespace, "a.ts")
    const first = await reviewPatchFingerprint("old patch")
    const next = await reviewPatchFingerprint("new patch")
    expect(first).not.toBe(next)
    useReviewedFiles.getState().setReviewed(key, first, true)
    useReviewedFiles.getState().observe(key, next)
    expect(useReviewedFiles.getState().marks[key]).toBeUndefined()
  })
  it("isolates marks by chat, project, range and whitespace preferences", () => {
    const key = reviewFileKey(namespace, "a.ts")
    useReviewedFiles.getState().setReviewed(key, "fingerprint", true)
    for (const change of [
      { scopeId: "session:two" },
      { rootPath: "D:/other" },
      { range: "staged" },
      { ignoreWhitespace: true },
    ])
      expect(
        useReviewedFiles.getState().marks[reviewFileKey({ ...namespace, ...change }, "a.ts")]
      ).toBeUndefined()
  })
  it("revalidates inactive files, clears disappeared files, and preserves a newer user decision", async () => {
    const store = useReviewedFiles.getState()
    for (const path of ["changed.ts", "gone.ts", "newer.ts"])
      store.setReviewed(reviewFileKey(namespace, path), await reviewPatchFingerprint("old"), true)
    let finish!: (patch: string) => void
    const pending = revalidateReviewedFiles(
      namespace,
      ["changed.ts", "newer.ts"],
      null,
      async (path) =>
        path === "changed.ts"
          ? "new"
          : new Promise((resolve) => {
              finish = resolve
            })
    )
    await Promise.resolve()
    store.setReviewed(
      reviewFileKey(namespace, "newer.ts"),
      await reviewPatchFingerprint("latest"),
      true
    )
    finish("outdated response")
    await pending
    expect(
      useReviewedFiles.getState().marks[reviewFileKey(namespace, "changed.ts")]
    ).toBeUndefined()
    expect(useReviewedFiles.getState().marks[reviewFileKey(namespace, "gone.ts")]).toBeUndefined()
    expect(useReviewedFiles.getState().marks[reviewFileKey(namespace, "newer.ts")]).toBe(
      await reviewPatchFingerprint("latest")
    )
  })
  it("preserves a same-patch mark made again after an older validation started", async () => {
    const key = reviewFileKey(namespace, "a.ts")
    const fingerprint = await reviewPatchFingerprint("reviewed patch")
    const store = useReviewedFiles.getState()
    store.setReviewed(key, fingerprint, true)
    let finish!: (patch: string) => void
    const pending = revalidateReviewedFiles(
      namespace,
      ["a.ts"],
      null,
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    store.setReviewed(key, fingerprint, false)
    store.setReviewed(key, fingerprint, true)
    finish("stale response")
    await pending
    expect(useReviewedFiles.getState().marks[key]).toBe(fingerprint)
  })
})
