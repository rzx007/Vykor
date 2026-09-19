import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getConfigDir } from "@openharness/core";

import bundledCatalog from "./api.json";
import {
  CODEX_DEFAULT_MODEL,
  SPECIAL_PROVIDER_CATALOG,
} from "./special-provider-catalog";

export interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevReasoningOption {
  type?: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  temperature?: boolean;
  tool_call?: boolean;
  cost?: ModelsDevCost;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  status?: "alpha" | "beta" | "deprecated";
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  api?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const DEFAULT_MODELS_URL = "https://models.dev/api.json";

export { CODEX_DEFAULT_MODEL };

const BUNDLED_FALLBACK_CATALOG = bundledCatalog as ModelsDevCatalog;

function modelsCachePath(): string {
  return join(getConfigDir(), "cache", "models-dev.json");
}

function modelsUrl(): string {
  return process.env.OPENHARNESS_MODELS_URL?.trim() || DEFAULT_MODELS_URL;
}

function configuredCatalogPath(): string | undefined {
  return process.env.OPENHARNESS_MODELS_PATH?.trim() || undefined;
}

async function readJsonFile(
  path: string,
): Promise<ModelsDevCatalog | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

function isUsableCatalog(
  value: ModelsDevCatalog | undefined,
): value is ModelsDevCatalog {
  return !!value && Object.keys(value).length > 0;
}

function withSpecialProviders(catalog: ModelsDevCatalog): ModelsDevCatalog {
  return { ...catalog, ...SPECIAL_PROVIDER_CATALOG };
}

export class ModelCatalogService {
  private loaded: ModelsDevCatalog | undefined;

  async load(): Promise<ModelsDevCatalog> {
    if (this.loaded) return this.loaded;

    const configuredPath = configuredCatalogPath();
    if (configuredPath) {
      const configured = await readJsonFile(configuredPath);
      if (isUsableCatalog(configured)) {
        this.loaded = withSpecialProviders(configured);
        return this.loaded;
      }
    }

    const cached = await readJsonFile(modelsCachePath());
    if (process.env.OPENHARNESS_DISABLE_MODELS_FETCH) {
      this.loaded = withSpecialProviders(BUNDLED_FALLBACK_CATALOG);
      return this.loaded;
    }

    try {
      const response = await fetch(modelsUrl(), {
        headers: { "User-Agent": "openharness-ts/models-catalog" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`Models.dev request failed: ${response.status}`);
      const text = await response.text();
      const parsed = JSON.parse(text) as ModelsDevCatalog;
      if (!isUsableCatalog(parsed))
        throw new Error("Models.dev returned an empty catalog");
      await mkdir(dirname(modelsCachePath()), { recursive: true });
      await writeFile(
        modelsCachePath(),
        JSON.stringify(parsed, null, 2) + "\n",
        "utf-8",
      );
      this.loaded = withSpecialProviders(parsed);
      return this.loaded;
    } catch {
      this.loaded = withSpecialProviders(
        isUsableCatalog(cached) ? cached : BUNDLED_FALLBACK_CATALOG,
      );
      return this.loaded;
    }
  }
}

export function createModelCatalogService(): ModelCatalogService {
  return new ModelCatalogService();
}
