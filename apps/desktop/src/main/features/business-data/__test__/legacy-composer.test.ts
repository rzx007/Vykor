import { expect, it } from "vitest"
import { classifyRecoverySessions } from "../legacy-composer"
it("classifies omitted archived and child sessions directly and keeps missing separate from memory", async () => {
  const ids = Array.from({ length: 402 }, (_, index) => `session-${index}`)
  const values = await classifyRecoverySessions(ids, async (id) => {
    if (id === "session-401") throw { status: 404 }
    return { storage: id === "session-0" ? "memory" : "persistent" }
  })
  expect(values["session-400"]).toBe("persistent")
  expect(values["session-401"]).toBe("unknown")
  expect(values["session-0"]).toBe("memory")
  await expect(
    classifyRecoverySessions(["session"], async () => {
      throw { status: 503 }
    })
  ).rejects.toThrow(/LOOKUP_FAILED/)
})

it("keeps an absent lookup record unknown", async () => {
  expect(await classifyRecoverySessions(["deleted"], async () => null)).toEqual({
    deleted: "unknown",
  })
})
