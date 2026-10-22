import { AppStateStore } from "./app-state";
import type { Settings } from "@vykor/host-config";

export { AppStateStore } from "./app-state";
export type { AppState } from "./app-state";

export function createStateStore(settings: Settings): AppStateStore {
  return new AppStateStore(settings);
}
