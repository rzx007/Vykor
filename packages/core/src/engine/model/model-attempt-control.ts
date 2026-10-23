// Keep host control failures distinct from provider failures without replacing
// their Error identity or mutating host-owned (possibly frozen) errors.
const controlFailures = new WeakSet<object>();

export function isModelAttemptControlFailure(error: unknown): boolean {
  return (typeof error === "object" && error !== null || typeof error === "function") && controlFailures.has(error);
}

export async function modelAttemptControl<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const error = typeof cause === "object" && cause !== null || typeof cause === "function"
      ? cause : new Error("Model attempt control failed", { cause });
    controlFailures.add(error);
    throw error;
  }
}
