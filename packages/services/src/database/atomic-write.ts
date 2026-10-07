import type { StorageContext } from "./storage-context.js";

export function atomicWrite<T>(storage: StorageContext, work: () => T, save?: () => void): T {
  const result = storage.atomic(work);
  save?.();
  return result;
}
