import type * as Data from "@vykor/plugin-contracts/marketplace";
import type * as Wire from "@vykor/protocol";

function sourceDto(source: Data.MarketplaceSource): Wire.MarketplaceSource {
  return { id: source.id, name: source.name, url: source.url, enabled: source.enabled, builtin: source.builtin };
}
export function marketplaceSourcesDto(input: { sources: Data.MarketplaceSource[] }): Wire.MarketplaceSourcesResponse {
  return { sources: input.sources.map(sourceDto) };
}
export function marketplaceCatalogDto(input: Data.MarketplaceCatalog): Wire.MarketplaceCatalog {
  return {
    sources: input.sources.map(source => ({ ...sourceDto(source),
      ...(source.updatedAt === undefined ? {} : { updatedAt: source.updatedAt }),
      ...(source.stale === undefined ? {} : { stale: source.stale }),
      ...(source.error === undefined ? {} : { error: source.error }) })),
    entries: input.entries.map(entry => {
      const plugin = entry.plugin;
      return { sourceId: entry.sourceId, compatible: entry.compatible, updateAvailable: entry.updateAvailable,
        ...(entry.installedVersion === undefined ? {} : { installedVersion: entry.installedVersion }),
        ...(entry.installedSourceId === undefined ? {} : { installedSourceId: entry.installedSourceId }),
        ...(entry.incompatibility === undefined ? {} : { incompatibility: entry.incompatibility }),
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version, category: plugin.category,
          componentTypes: [...plugin.componentTypes],
          ...(plugin.displayName === undefined ? {} : { displayName: plugin.displayName }),
          ...(plugin.description === undefined ? {} : { description: plugin.description }),
          ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
          ...(plugin.introduction === undefined ? {} : { introduction: plugin.introduction }),
          ...(plugin.prompts === undefined ? {} : { prompts: plugin.prompts.map(({ title, prompt }) => ({ title, prompt })) }),
          ...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
          ...(plugin.license === undefined ? {} : { license: plugin.license }),
          ...(plugin.keywords === undefined ? {} : { keywords: [...plugin.keywords] }),
          ...(plugin.author === undefined ? {} : { author: { name: plugin.author.name,
            ...(plugin.author.url === undefined ? {} : { url: plugin.author.url }),
            ...(plugin.author.email === undefined ? {} : { email: plugin.author.email }) } }),
          artifact: { url: plugin.artifact.url, sha256: plugin.artifact.sha256, size: plugin.artifact.size },
          requires: { host: plugin.requires.host, ...(plugin.requires.node === undefined ? {} : { node: plugin.requires.node }),
            ...(plugin.requires.platforms === undefined ? {} : { platforms: [...plugin.requires.platforms] }) },
          source: { repository: plugin.source.repository, commit: plugin.source.commit, path: plugin.source.path } } };
    }),
  };
}
export function marketplacePreviewDto(input: Data.MarketplacePreview): Wire.MarketplacePreview {
  return { candidateId: input.candidateId, identity: { id: input.identity.id, name: input.identity.name, version: input.identity.version,
    ...(input.identity.displayName === undefined ? {} : { displayName: input.identity.displayName }) },
    requestedPermissions: [...input.requestedPermissions], approvalRequired: input.approvalRequired,
    replacementRequired: input.replacementRequired, sourceName: input.sourceName };
}
export function marketplaceOperationDto(input: Data.MarketplaceOperation): Wire.MarketplaceOperation {
  return { operationId: input.operationId, status: input.status, message: input.message,
    ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.code === undefined ? {} : { code: input.code }) };
}
