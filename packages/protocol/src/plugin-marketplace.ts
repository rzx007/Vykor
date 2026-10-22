import type { MarketplaceInstallInput, MarketplaceSelection, MarketplaceSource } from "@vykor/plugin-contracts/marketplace";
import { ProtocolValidationError } from "./requests.js";

// Capability data keeps its canonical owner; HTTP envelopes and parsing live here.
export interface MarketplaceCatalogRequest { cwd: string; refresh?: boolean }
export interface MarketplaceSourcesResponse { sources: MarketplaceSource[] }
export interface MarketplaceAddSourceRequest { url: string }
export interface MarketplaceSourceEnabledRequest { enabled: boolean }
export interface MarketplacePreviewRequest extends MarketplaceSelection {}
export interface MarketplaceInstallRequest extends MarketplaceInstallInput {}
export interface MarketplaceCancelRequest { candidateId: string }
export interface MarketplaceCancelResponse { cancelled: true }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolValidationError("Request must be a JSON object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ProtocolValidationError("Unknown marketplace field", key);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new ProtocolValidationError(`${field} is required or too long`, field);
  return value;
}
export function parseMarketplaceCatalogRequest(value: unknown): MarketplaceCatalogRequest {
  const body = record(value, ["cwd", "refresh"]);
  const refresh = body.refresh;
  if (refresh !== undefined && typeof refresh !== "boolean" && refresh !== "true" && refresh !== "false")
    throw new ProtocolValidationError("refresh must be a boolean", "refresh");
  return { cwd: text(body.cwd, "cwd"), ...(refresh === undefined ? {} : { refresh: refresh === true || refresh === "true" }) };
}
export function parseMarketplaceAddSourceRequest(value: unknown): MarketplaceAddSourceRequest {
  const body = record(value, ["url"]);
  return { url: text(body.url, "url") };
}
export function parseMarketplaceSourceEnabledRequest(value: unknown): MarketplaceSourceEnabledRequest {
  const body = record(value, ["enabled"]);
  if (typeof body.enabled !== "boolean") throw new ProtocolValidationError("enabled must be a boolean", "enabled");
  return { enabled: body.enabled };
}
export function parseMarketplacePreviewRequest(value: unknown): MarketplacePreviewRequest {
  const body = record(value, ["cwd", "sourceId", "pluginId", "version"]);
  return { cwd: text(body.cwd, "cwd"), sourceId: text(body.sourceId, "sourceId"),
    pluginId: text(body.pluginId, "pluginId"), version: text(body.version, "version") };
}
export function parseMarketplaceCancelRequest(value: unknown): MarketplaceCancelRequest {
  const body = record(value, ["candidateId"]);
  return { candidateId: text(body.candidateId, "candidateId") };
}
export function parseMarketplaceInstallRequest(value: unknown): MarketplaceInstallRequest {
  const body = record(value, ["cwd", "candidateId", "operationId", "approvedPermissions", "allowSourceChange"]);
  if (!Array.isArray(body.approvedPermissions) || body.approvedPermissions.length > 256
    || body.approvedPermissions.some(item => typeof item !== "string" || item.length > 4096))
    throw new ProtocolValidationError("Invalid plugin permission approval", "approvedPermissions");
  if (body.allowSourceChange !== undefined && typeof body.allowSourceChange !== "boolean")
    throw new ProtocolValidationError("allowSourceChange must be a boolean", "allowSourceChange");
  return { cwd: text(body.cwd, "cwd"), candidateId: text(body.candidateId, "candidateId"),
    operationId: text(body.operationId, "operationId"), approvedPermissions: [...body.approvedPermissions],
    ...(body.allowSourceChange === undefined ? {} : { allowSourceChange: body.allowSourceChange }) };
}
