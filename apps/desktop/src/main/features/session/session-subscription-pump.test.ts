import { describe, expect, it, vi } from "vitest"

import { pumpSubscription } from "./session-subscription-pump"

describe("pumpSubscription", () => {
  it("rebuilds the iterator after an error and continues", async () => {
    const updates: number[] = []
    const reconnecting: number[] = []
    const errors: unknown[] = []
    let created = 0
    let active = true
    const failing: AsyncIterator<number> = {
      next: async () => {
        throw new Error("boom")
      },
    }
    const working = (async function* () {
      yield 1
      await new Promise(() => {})
    })()

    await pumpSubscription<number>({
      createIterator: () => {
        created += 1
        return created === 1 ? failing : working[Symbol.asyncIterator]()
      },
      isActive: () => active,
      onUpdate: (value) => {
        updates.push(value)
        active = false
      },
      onReconnecting: (value) => reconnecting.push(value),
      onError: (error) => errors.push(error),
      backoffMs: () => 0,
    })

    expect(created).toBe(2)
    expect(updates).toEqual([1])
    expect(errors).toHaveLength(1)
    expect(reconnecting).toEqual([])
  })

  it("reports the last update when rebuilding after a clean end", async () => {
    const events: string[] = []
    let created = 0
    let active = true
    const first = (async function* () {
      yield "a"
    })()
    const second = (async function* () {
      yield "b"
      await new Promise(() => {})
    })()

    await pumpSubscription<string>({
      createIterator: () => {
        created += 1
        return (created === 1 ? first : second)[Symbol.asyncIterator]()
      },
      isActive: () => active,
      onUpdate: (value) => {
        events.push(value)
        if (value === "b") active = false
      },
      onReconnecting: (value) => events.push(`reconnecting:${value}`),
      backoffMs: () => 0,
    })

    expect(events).toEqual(["a", "reconnecting:a", "b"])
  })

  it("drops an update that arrives after the subscription went inactive", async () => {
    const updates: number[] = []
    let active = true
    const iterator: AsyncIterator<number> = {
      next: async () => {
        active = false
        return { done: false, value: 1 }
      },
    }

    await pumpSubscription<number>({
      createIterator: () => iterator,
      isActive: () => active,
      onUpdate: (value) => updates.push(value),
      backoffMs: () => 0,
    })

    expect(updates).toEqual([])
  })

  it("stops immediately when inactive", async () => {
    const createIterator = vi.fn()
    await pumpSubscription<number>({
      createIterator,
      isActive: () => false,
      onUpdate: () => {},
    })
    expect(createIterator).not.toHaveBeenCalled()
  })
})
