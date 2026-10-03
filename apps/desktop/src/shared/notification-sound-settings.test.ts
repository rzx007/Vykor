import { describe, expect, it } from "vitest"
import { normalizeNotificationSounds } from "./settings-types"

describe("notification sound preferences", () => {
  it("defaults missing sounds and keeps previously muted categories muted", () => {
    expect(normalizeNotificationSounds(undefined)).toEqual({
      completed: "staplebops-01",
      needs_input: "staplebops-02",
      failed: "nope-03",
    })
    expect(
      normalizeNotificationSounds({ completed: false, needs_input: true, failed: false })
    ).toEqual({
      completed: "none",
      needs_input: "staplebops-02",
      failed: "none",
    })
  })

  it("preserves selected sounds and rejects missing files", () => {
    expect(
      normalizeNotificationSounds({
        completed: "bip-bop-08",
        needs_input: "none",
        failed: "yup-06",
      })
    ).toEqual({
      completed: "bip-bop-08",
      needs_input: "none",
      failed: "yup-06",
    })
    expect(
      normalizeNotificationSounds({
        completed: "../unknown",
        needs_input: "alert-99",
        failed: "nope-12",
      })
    ).toEqual({
      completed: "staplebops-01",
      needs_input: "staplebops-02",
      failed: "nope-12",
    })
  })
})
