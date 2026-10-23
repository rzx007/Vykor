/**
 * Combine a tool's execution deadline with its owning session run signal.
 * Call dispose once the underlying operation settles so listeners and timers
 * do not accumulate across long-lived daemon runtimes.
 */
export function createToolAbortScope(externalSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Tool operation timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timeout.unref?.();

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}
