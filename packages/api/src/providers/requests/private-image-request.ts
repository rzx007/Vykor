import { ModelRequestFailure } from "@vykor/agent-contracts";
import type OpenAI from "openai";
import type {} from "openai/shims/node";
import type {} from "@anthropic-ai/sdk/shims/node";
import { _iterSSEMessages } from "openai/streaming";
import { protocolFailure, toModelRequestFailure } from "../../errors/index.js";

type SdkTransport = {
  buildRequest(options: { method: "post"; path: string; body: object; signal: AbortSignal; stream: true }): ReturnType<OpenAI["buildRequest"]>;
  fetchWithTimeout: OpenAI["fetchWithTimeout"];
};
type SdkResponse = Awaited<ReturnType<SdkTransport["fetchWithTimeout"]>>;

function privateImageFailure(error: unknown, phase: "request" | "stream"): ModelRequestFailure {
  const { requestId: _untrusted, ...info } = toModelRequestFailure(error, phase).info;
  return new ModelRequestFailure("Provider rejected the private window capture request.", info);
}

async function* readPrivateEvents<Event>(response: SdkResponse, controller: AbortController): AsyncIterable<Event> {
  try {
    for await (const frame of _iterSSEMessages(response, controller)) {
      if (frame.data === "[DONE]") return;
      if (!frame.data || frame.event === "ping") continue;
      let event: { error?: unknown } | null;
      try {
        event = JSON.parse(frame.data);
      } catch {
        throw protocolFailure("Provider returned an invalid event for the private window capture request.");
      }
      if (frame.event === "error" || event?.error) {
        throw privateImageFailure({ error: event?.error, headers: response.headers }, "stream");
      }
      if (event && typeof event === "object") yield event as Event;
    }
  } finally {
    controller.abort();
  }
}

/** Reuse SDK authentication and transport. The SDK request and JSON event parsers can log raw bodies. */
export async function requestWithPrivateImage<Event>(
  sdk: SdkTransport,
  path: string,
  body: object,
  signal: AbortSignal,
): Promise<{ stream: AsyncIterable<Event>; headers: SdkResponse["headers"] }> {
  signal.throwIfAborted();
  const { req, url, timeout } = sdk.buildRequest({ method: "post", path, body, signal, stream: true });
  const controller = new AbortController();
  const response = await sdk.fetchWithTimeout(url, req, timeout, controller);
  if (!response.ok) {
    try {
      const message = await response.text();
      let error: unknown;
      try { error = JSON.parse(message)?.error; } catch { /* plain text error */ }
      throw privateImageFailure({ status: response.status, headers: response.headers, error, message }, "request");
    } finally {
      controller.abort();
    }
  }
  return { stream: readPrivateEvents<Event>(response, controller), headers: response.headers };
}
