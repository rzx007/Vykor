import type * as Wire from "@vykor/protocol";
import type * as App from "../../application/maintenance/query-models.js";

function usagePriceDto(input: Wire.UsagePrice): Wire.UsagePrice {
  return { provider: input.provider, model: input.model, currency: input.currency, source: input.source, adoptedAt: input.adoptedAt,
    inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion, cacheReadPerMillion: input.cacheReadPerMillion,
    cacheCreationPerMillion: input.cacheCreationPerMillion, subscription: input.subscription,
    ...(input.inputIncludesCache !== undefined ? { inputIncludesCache: input.inputIncludesCache } : {}) };
}
export function usageReportDto(input: App.UsageReport): Wire.UsageReport {
  return { scannedAt: input.scannedAt, requests: input.requests.map(item => ({ id: item.id, time: item.time, project: item.project,
    sessionId: item.sessionId, runId: item.runId, provider: item.provider, model: item.model, status: item.status, completeness: item.completeness,
    inputTokens: item.inputTokens, outputTokens: item.outputTokens, cacheReadTokens: item.cacheReadTokens, cacheCreationTokens: item.cacheCreationTokens,
    cost: item.cost ? { amount: item.cost.amount, currency: item.cost.currency, kind: item.cost.kind, source: item.cost.source,
      adoptedAt: item.cost.adoptedAt, price: usagePriceDto(item.cost.price) } : null,
    ...(item.subscription !== undefined ? { subscription: item.subscription } : {}) })), warnings: input.warnings,
    options: { projects: input.options.projects, providers: input.options.providers, models: input.options.models },
    totals: { requests: input.totals.requests, unknown: input.totals.unknown, partial: input.totals.partial, input: input.totals.input,
      output: input.totals.output, cacheRead: input.totals.cacheRead, cacheCreation: input.totals.cacheCreation, costs: input.totals.costs },
    settings: { version: input.settings.version, prices: input.settings.prices.map(usagePriceDto),
      budget: { enabled: input.settings.budget.enabled, tokens: input.settings.budget.tokens, amount: input.settings.budget.amount, currency: input.settings.budget.currency } } };
}
function backupManifestDto(input: Wire.MaintenanceBackupManifest): Wire.MaintenanceBackupManifest {
  return { version: input.version, backupId: input.backupId, createdAt: input.createdAt, database: input.database,
    directories: { artifacts: input.directories.artifacts, memory: input.directories.memory, "execution-output": input.directories["execution-output"],
      attachments: input.directories.attachments, ...(input.directories.notes !== undefined ? { notes: input.directories.notes } : {}) },
    ...(input.attachments ? { attachments: { assets: input.attachments.assets, uniqueBlobs: input.attachments.uniqueBlobs, physicalBytes: input.attachments.physicalBytes,
      consistency: { errors: input.attachments.consistency.errors, warnings: input.attachments.consistency.warnings, issueCounts: input.attachments.consistency.issueCounts } } } : {}),
    recovery: { reviveLiveProcesses: input.recovery.reviveLiveProcesses, closeActiveRecordsOnStartup: input.recovery.closeActiveRecordsOnStartup } };
}
export function storageReportDto(input: App.StorageReport): Wire.StorageReport {
  return { scannedAt: input.scannedAt, dataDirectory: input.dataDirectory, totalBytes: input.totalBytes, availableBytes: input.availableBytes, writable: input.writable,
    categories: input.categories.map(item => ({ id: item.id, name: item.name, paths: item.paths, bytes: item.bytes, files: item.files, errors: item.errors })),
    ...(input.backups ? { backups: input.backups.map(item => ({ path: item.path, createdAt: item.createdAt, bytes: item.bytes, manifest: backupManifestDto(item.manifest) })) } : {}) };
}
export function cleanupPreviewDto(input: App.CleanupPreview): Wire.CleanupPreview {
  return { id: input.id, createdAt: input.createdAt, olderThan: input.olderThan,
    candidates: input.candidates.map(item => ({ id: item.id, kind: item.kind, label: item.label, updatedAt: item.updatedAt, bytes: item.bytes,
      ...(item.children !== undefined ? { children: item.children } : {}), ...(item.attachments !== undefined ? { attachments: item.attachments } : {}) })),
    protected: input.protected.map(item => ({ id: item.id, reason: item.reason })), bytes: input.bytes, scope: input.scope };
}
export function cleanupResultDto(input: App.CleanupResult): Wire.CleanupResult {
  return { auditId: input.auditId, completed: input.completed, skipped: input.skipped.map(item => ({ id: item.id, reason: item.reason })),
    failures: input.failures.map(item => ({ id: item.id, reason: item.reason })), releasedBytes: input.releasedBytes };
}
