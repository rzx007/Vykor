import { isPluginIconSource } from "./presentation.js";

/** Distribution metadata describes install candidates; it never grants runtime permission. */
export interface MarketplacePlugin {
  id: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  icon?: string;
  introduction?: string;
  prompts?: Array<{ title: string; prompt: string }>;
  homepage?: string;
  author?: { name: string; url?: string; email?: string };
  license?: string;
  keywords?: string[];
  category: string;
  componentTypes: string[];
  artifact: { url: string; sha256: string; size: number };
  requires: { host: string; node?: string; platforms?: string[] };
  source: { repository: string; commit: string; path: string };
}
export interface MarketplaceDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  owner: { name: string };
  plugins: MarketplacePlugin[];
}
export interface MarketplaceSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  builtin: boolean;
}
export interface MarketplaceProvenance {
  sourceId: string;
  catalogUrl: string;
  version: string;
  archiveDigest: string;
  repository: string;
  commit: string;
  path: string;
}
export interface MarketplaceSourceView extends MarketplaceSource {
  updatedAt?: string;
  stale?: boolean;
  error?: string;
}
export interface MarketplaceEntry {
  sourceId: string;
  plugin: MarketplacePlugin;
  installedVersion?: string;
  installedSourceId?: string;
  updateAvailable: boolean;
  compatible: boolean;
  incompatibility?: string;
}
export interface MarketplaceCatalog {
  sources: MarketplaceSourceView[];
  entries: MarketplaceEntry[];
}
export interface MarketplaceSelection {
  cwd: string;
  sourceId: string;
  pluginId: string;
  version: string;
}
export interface MarketplacePreview {
  candidateId: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  replacementRequired: boolean;
  sourceName: string;
}
export interface MarketplaceInstallInput {
  cwd: string;
  candidateId: string;
  operationId: string;
  approvedPermissions: string[];
  allowSourceChange?: boolean;
}
export interface MarketplaceOperation {
  operationId: string;
  status: "pending" | "installed" | "failed" | "unknown";
  pluginId?: string;
  version?: string;
  message: string;
  code?: string;
}

export const MARKETPLACE_LIMITS = {
  catalogBytes: 2 * 1024 * 1024,
  archiveBytes: 100 * 1024 * 1024,
  plugins: 1000,
  cacheMs: 15 * 60_000,
  candidateMs: 10 * 60_000,
} as const;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid marketplace object");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid marketplace text");
  return value;
}
function strings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Invalid marketplace list");
  return value.map((x) => string(x, 256));
}
export function normalizeMarketplaceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "插件源和下载地址必须使用 HTTPS，且不能包含凭据或自定义端口。",
    );
  return url.href;
}
function version(value: unknown): string {
  const result = string(value, 64);
  if (!VERSION.test(result))
    throw new Error("Marketplace requires a stable semantic version");
  return result;
}
function minimum(value: unknown): string {
  const result = string(value, 66);
  if (!result.startsWith(">=") || !VERSION.test(result.slice(2)))
    throw new Error("Only >=stable semantic version minimums are supported");
  return result;
}
export function compareMarketplaceVersions(
  left: string,
  right: string,
): number {
  const a = version(left).split(".").map(Number);
  const b = version(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  return 0;
}
export function satisfiesMarketplaceMinimum(
  actual: string,
  required: string,
): boolean {
  return compareMarketplaceVersions(actual, minimum(required).slice(2)) >= 0;
}
export function parseMarketplaceDocument(input: unknown): MarketplaceDocument {
  const root = record(input);
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.plugins) ||
    root.plugins.length > MARKETPLACE_LIMITS.plugins
  )
    throw new Error("Unsupported marketplace document");
  const ids = new Set<string>();
  const plugins = root.plugins.map((raw) => {
    const item = record(raw);
    const artifact = record(item.artifact);
    const requires = record(item.requires);
    const source = record(item.source);
    const id = string(item.id, 256);
    const name = string(item.name, 128);
    if (
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(id) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      ids.has(id)
    )
      throw new Error("Invalid or duplicate marketplace plugin identity");
    ids.add(id);
    const digest = string(artifact.sha256, 64);
    const size = artifact.size;
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 1 ||
      (size as number) > MARKETPLACE_LIMITS.archiveBytes
    )
      throw new Error("Invalid marketplace artifact digest or size");
    const path = string(source.path, 1024);
    const commit = string(source.commit, 64);
    if (
      !/^[a-f0-9]{40,64}$/.test(commit) ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((x) => !x || x === "." || x === ".." || x.includes(":"))
    )
      throw new Error("Invalid marketplace source reference");
    const plugin: MarketplacePlugin = {
      id,
      name,
      version: version(item.version),
      category: string(item.category, 64),
      componentTypes: strings(item.componentTypes, 16),
      artifact: {
        url: normalizeMarketplaceUrl(string(artifact.url)),
        sha256: digest,
        size: size as number,
      },
      requires: {
        host: minimum(requires.host),
        ...(requires.node === undefined
          ? {}
          : { node: minimum(requires.node) }),
        ...(requires.platforms === undefined
          ? {}
          : { platforms: strings(requires.platforms, 16) }),
      },
      source: {
        repository: normalizeMarketplaceUrl(string(source.repository)),
        commit,
        path,
      },
    };
    for (const key of ["displayName", "description", "introduction", "license"] as const)
      if (item[key] !== undefined)
        plugin[key] = string(item[key], key === "introduction" ? 65536 : key === "description" ? 16384 : 256);
    if (item.icon !== undefined) {
      const icon = string(item.icon, 1_048_576);
      if (!isPluginIconSource(icon)) throw new Error("Invalid marketplace icon");
      if (!icon.startsWith("data:")) normalizeMarketplaceUrl(icon);
      plugin.icon = icon;
    }
    if (item.homepage !== undefined) plugin.homepage = normalizeMarketplaceUrl(string(item.homepage));
    if (item.prompts !== undefined) {
      if (!Array.isArray(item.prompts) || item.prompts.length > 16)
        throw new Error("Invalid marketplace examples");
      plugin.prompts = item.prompts.map(raw => {
        const example = record(raw);
        return { title: string(example.title, 100).trim(), prompt: string(example.prompt, 16384).trim() };
      });
    }
    if (item.keywords !== undefined) plugin.keywords = strings(item.keywords);
    if (item.author !== undefined) {
      const author = record(item.author);
      plugin.author = { name: string(author.name, 256) };
      for (const key of ["url", "email"] as const)
        if (author[key] !== undefined)
          plugin.author[key] = string(author[key], 1024);
    }
    return plugin;
  });
  return {
    schemaVersion: 1,
    id: string(root.id, 128),
    name: string(root.name, 256),
    owner: { name: string(record(root.owner).name, 256) },
    plugins,
  };
}
