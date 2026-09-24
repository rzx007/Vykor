import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

type FrecencyStore = {
  command: Record<string, number[]>;
  file: Record<string, number[]>;
};

let store: FrecencyStore | null = null;
let dirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function configPath(): string {
  const dir = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  mkdirSync(dir, { recursive: true });
  return join(dir, "frecency.json");
}

function load(): FrecencyStore {
  if (store !== null) return store;
  try {
    const raw = readFileSync(configPath(), "utf-8");
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
  debounceTimer = setTimeout(() => {
    if (store && dirty) {
      try {
        writeFileSync(configPath(), JSON.stringify(store));
      } catch { /* silent */ }
      dirty = false;
    }
  }, 500);
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
