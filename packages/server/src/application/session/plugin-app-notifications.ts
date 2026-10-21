import { randomUUID } from "node:crypto";
import type { PluginAppResourceNotice } from "@vykor/protocol";

/** Ephemeral invalidations only: never goes through the conversation event store. */
export class PluginAppNotifications {
  readonly runtimeEpoch = randomUUID();
  stream(start: (emit: (notice: PluginAppResourceNotice) => void, signal: AbortSignal) => Promise<void>, requestSignal: AbortSignal) {
    const abort = new AbortController(), encoder = new TextEncoder();
    const cancel = () => abort.abort();
    requestSignal.addEventListener("abort", cancel, { once: true });
    if (requestSignal.aborted) cancel();
    return new ReadableStream<Uint8Array>({
      start: controller => {
        if (abort.signal.aborted) { requestSignal.removeEventListener("abort", cancel); controller.close(); return; }
        let closed = false;
        const emit = (notice: PluginAppResourceNotice) => {
          if (closed || abort.signal.aborted) return;
          if ((controller.desiredSize ?? 0) < -64) { cancel(); return; }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(notice)}\n\n`));
        };
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 15_000);
        heartbeat.unref?.();
        abort.signal.addEventListener("abort", () => {
          closed = true; clearInterval(heartbeat); requestSignal.removeEventListener("abort", cancel);
          try { controller.close(); } catch { /* cancelled reader */ }
        }, { once: true });
        void start(emit, abort.signal).then(() => emit({ kind: "resync", runtimeEpoch: this.runtimeEpoch })).catch(() => cancel());
      },
      cancel,
    });
  }
}
