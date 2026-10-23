import { describe, expect, it } from "vitest";

import { createToolAbortScope } from "../abort.js";
import { webFetchTool } from "../../web/fetch.js";

describe("tool cancellation", () => {
  it("forwards a session interrupt into an in-flight web request", async () => {
    const external = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      const execution = webFetchTool.execute(
        { url: "https://example.invalid" },
        { cwd: process.cwd(), abortSignal: external.signal },
      );
      external.abort(new Error("session interrupted"));

      await expect(execution).resolves.toMatchObject({ isError: true });
      expect(requestSignal).toBeDefined();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops forwarding external aborts after the scope is disposed", () => {
    const external = new AbortController();
    const scope = createToolAbortScope(external.signal, 60_000);
    scope.dispose();
    external.abort(new Error("later"));
    expect(scope.signal.aborted).toBe(false);
  });
});
