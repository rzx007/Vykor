import type { RuntimeBundle } from "@vykor/core";
import { getSandboxAvailability, type SandboxRuntimeReporter } from "@vykor/sandbox";

export async function attachSandboxRuntime(
  bundle: RuntimeBundle,
  _cwd: string,
  reporter?: SandboxRuntimeReporter,
  _sessionId?: string,
): Promise<void> {
  reporter?.({ type: "check-availability", backend: "srt" });
  const availability = getSandboxAvailability(bundle.settings.sandbox);
  bundle.sandboxStatus = {
    state: !availability.enabled ? "off" : availability.available ? "active" : "unavailable",
    ...availability,
  };
  reporter?.(availability.available
    ? { type: "ready", backend: "srt" }
    : { type: "unavailable", backend: "srt", reason: availability.reason });
}
