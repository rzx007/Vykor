import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getFrecencyFilePath } from "@vykor/host-config/paths";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

type FrecencyStore = {
  command: Record<string, number[]>;
  file: Record<string, number[]>;
};

let store: FrecencyStore | null = null;
let dirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

let storePath: string | null = null;

function load(): FrecencyStore {
  if (store !== null) return store;
  storePath = getFrecencyFilePath();
  try {
    const raw = readFileSync(storePath, "utf-8");
    store = JSON.parse(raw) as FrecencyStore;
    if (!store.command) store.command = {};
    if (!store.file) store.file = {};
  } catch {
    store = { command: {}, file: {} };
  }
  return store;
}

function scheduleSave(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { try { flushFrecency(); } catch { /* Keep dirty data for explicit retry. */ } }, 500);
}

/** Flush the path captured on load; a changed environment cannot redirect a pending save. */
export function flushFrecency(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (!store || !dirty || !storePath) return;
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store));
  dirty = false;
}

/** Call before disposal/root migration; a failed flush keeps the cache available for retry. */
export function closeFrecency(): void {
  flushFrecency();
  store = null;
  storePath = null;
}

export function computeScore(timestamps: number[]): number {
  const now = Date.now();
  return timestamps.reduce((sum, ts) => {
    return sum + Math.pow(2, -(now - ts) / HALF_LIFE_MS);
  }, 0);
}

export function record(kind: "command" | "file", key: string): void {
  const s = load();
  if (!s[kind][key]) s[kind][key] = [];
  s[kind][key]!.push(Date.now());
  dirty = true;
  scheduleSave();
}

export function rank(kind: "command" | "file"): Map<string, number> {
  const s = load();
  const map = new Map<string, number>();
  for (const [key, timestamps] of Object.entries(s[kind])) {
    map.set(key, computeScore(timestamps));
  }
  return map;
}
