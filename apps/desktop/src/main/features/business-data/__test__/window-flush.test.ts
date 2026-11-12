import { expect, it, vi } from "vitest"
import {
  acknowledgeBusinessDataFlush,
  requestWindowBusinessDataFlush,
  trackBusinessDataWindow,
  markBusinessDataWindowReady,
} from "../window-flush"
it("waits for the matching renderer acknowledgement and rejects failed flushes", async () => {
  const sent: string[] = []
  const sender = {
    id: 42,
    once: vi.fn(),
    isDestroyed: () => false,
    send: (_channel: string, id: string) => sent.push(id),
  }
  trackBusinessDataWindow(sender as never)
  markBusinessDataWindowReady(sender.id)
  let finished = false
  const pending = requestWindowBusinessDataFlush(sender as never).then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  acknowledgeBusinessDataFlush(43, sent[0], true)
  await Promise.resolve()
  expect(finished).toBe(false)
  acknowledgeBusinessDataFlush(42, sent[0], true)
  await pending
  expect(finished).toBe(true)
  const failed = requestWindowBusinessDataFlush(sender as never)
  acknowledgeBusinessDataFlush(42, sent[1], false)
  await expect(failed).rejects.toThrow(/FLUSH_FAILED/)
})

it("does not wait for a cold tracked window that has no renderer consumer yet", async () => {
  const sender = { id: 7, isDestroyed: () => false, once: vi.fn(), send: vi.fn() }
  trackBusinessDataWindow(sender as never)
  const pending = requestWindowBusinessDataFlush(sender as never)
  expect(sender.send).not.toHaveBeenCalled()
  await pending
})

it("ignores registration from non-business windows", async () => {
  const sender = { id: 9, isDestroyed: () => false, send: vi.fn() }
  markBusinessDataWindowReady(sender.id)
  await requestWindowBusinessDataFlush(sender as never)
  expect(sender.send).not.toHaveBeenCalled()
})
