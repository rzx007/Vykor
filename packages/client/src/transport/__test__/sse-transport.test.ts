import { describe, expect, it } from "vitest"

import type { HttpTransport } from "../http-transport"
import { SseTransport } from "../sse-transport"

function transportWith(
  body: (signal: AbortSignal) => ReadableStream<Uint8Array>
): HttpTransport {
  return {
    baseUrl: "http://localhost",
    requestResponse: async (_path: string, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal ?? new AbortController().signal
      return new Response(body(signal))
    },
  } as unknown as HttpTransport
}

function silentBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => controller.error(new DOMException("Aborted", "AbortError")),
        { once: true }
      )
    },
  })
}

function keepaliveBody(
  signal: AbortSignal,
  options: { keepaliveMs: number; eventAtMs: number }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const interval = setInterval(
        () => controller.enqueue(encoder.encode(": keepalive\n\n")),
        options.keepaliveMs
      )
      const eventTimer = setTimeout(() => {
        clearInterval(interval)
        controller.enqueue(encoder.encode('data: {"seq":1}\n\n'))
        setTimeout(() => controller.close(), 5)
      }, options.eventAtMs)
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(interval)
          clearTimeout(eventTimer)
          controller.error(new DOMException("Aborted", "AbortError"))
        },
        { once: true }
      )
    },
  })
}

describe("SseTransport idle timeout", () => {
  it("ends the stream when no frame arrives within idleTimeoutMs", async () => {
    const transport = new SseTransport(transportWith(silentBody))
    const received: unknown[] = []
    for await (const event of transport.stream("http://localhost/events", {
      idleTimeoutMs: 20,
    })) {
      received.push(event)
    }
    expect(received).toEqual([])
  })

  it("keeps the stream alive while keepalive frames arrive", async () => {
    const transport = new SseTransport(
      transportWith((signal) => keepaliveBody(signal, { keepaliveMs: 5, eventAtMs: 45 }))
    )
    const received: unknown[] = []
    for await (const event of transport.stream("http://localhost/events", {
      idleTimeoutMs: 20,
    })) {
      received.push(event)
    }
    expect(received).toEqual([{ seq: 1 }])
  })
})
