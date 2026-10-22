import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getInstalledPluginStorePath,
  getPluginCacheDir,
  getPluginSourcesDir,
} from "@vykor/host-config";
import {
  computePluginBehaviorDigest,
  installLocalNativePlugin,
  loadNativePlugin,
  prunePluginInstallOperations,
  readInstalledPluginStore,
  requestedPluginPermissions,
  updateInstalledPluginStore,
  validateNativePlugin,
  type StoredPluginInstallOperation,
} from "@vykor/plugins";
import {
  MarketplaceRepository,
  resolveLocalPluginArchive,
} from "@vykor/plugin-sources";
import {
  compareMarketplaceVersions,
  MARKETPLACE_LIMITS,
  satisfiesMarketplaceMinimum,
  type MarketplaceCatalog,
  type MarketplaceInstallInput,
  type MarketplaceOperation,
  type MarketplacePlugin,
  type MarketplacePreview,
  type MarketplaceProvenance,
  type MarketplaceSelection,
  type MarketplaceSource,
} from "@vykor/plugin-contracts/marketplace";

interface Candidate {
  id: string;
  cwd: string;
  source: MarketplaceSource;
  plugin: MarketplacePlugin;
  requested: string[];
  behaviorDigest: string;
  root: string;
  expiresAt: number;
  cleanup(): Promise<void>;
  busy?: boolean;
  cancelled?: boolean;
}
export interface MarketplaceServiceOptions {
  repository?: MarketplaceRepository;
  storePath?: string;
  cacheDir?: string;
  hostVersion?: string;
  nodeVersion?: string;
  now?: () => number;
}
export function createMarketplaceService(
  options: MarketplaceServiceOptions = {},
) {
  return new PluginMarketplaceService(options);
}
export class PluginMarketplaceService {
  private readonly repository: MarketplaceRepository;
  private readonly candidates = new Map<string, Candidate>();
  private readonly running = new Map<
    string,
    { fingerprint: string; promise: Promise<MarketplaceOperation> }
  >();
  private readonly now: () => number;
  private nodeVersion?: Promise<string>;
  constructor(private readonly options: MarketplaceServiceOptions) {
    this.repository =
      options.repository ??
      new MarketplaceRepository({ directory: getPluginSourcesDir() });
    this.now = options.now ?? Date.now;
  }
  private get storePath() {
    return this.options.storePath ?? getInstalledPluginStorePath();
  }
  async sources() {
    return { sources: await this.repository.sources() };
  }
  async addSource(url: string) {
    await this.repository.addSource(url);
    return this.sources();
  }
  async setSourceEnabled(id: string, enabled: boolean) {
    await this.repository.setEnabled(id, enabled);
    if (!enabled) await this.retireSource(id);
    return this.sources();
  }
  async removeSource(id: string) {
    await this.repository.removeSource(id);
    await this.retireSource(id);
    return this.sources();
  }
  private async retireSource(id: string) {
    for (const candidate of [...this.candidates.values()])
      if (candidate.source.id === id) await this.cancel(candidate.id);
  }
  private async runtimeNodeVersion() {
    this.nodeVersion ??= this.options.nodeVersion
      ? Promise.resolve(this.options.nodeVersion)
      : promisify(execFile)("node", ["--version"], {
          windowsHide: true,
          timeout: 5000,
        })
          .then((x) => x.stdout.trim().replace(/^v/, ""))
          .catch(() => "0.0.0");
    return this.nodeVersion;
  }
  private async incompatible(
    plugin: MarketplacePlugin,
  ): Promise<string | undefined> {
    if (!this.options.hostVersion)
      return "无法确认宿主版本，请使用支持插件市场的新版 Vykor。";
    if (
      !satisfiesMarketplaceMinimum(
        this.options.hostVersion,
        plugin.requires.host,
      )
    )
      return `需要 Vykor ${plugin.requires.host}。`;
    if (
      plugin.requires.node &&
      !satisfiesMarketplaceMinimum(
        await this.runtimeNodeVersion(),
        plugin.requires.node,
      )
    )
      return `需要 Node.js ${plugin.requires.node}。`;
    if (
      plugin.requires.platforms &&
      !plugin.requires.platforms.includes(process.platform)
    )
      return "当前系统暂不支持此插件。";
    return undefined;
  }
  async catalog(input: {
    cwd: string;
    refresh?: boolean;
  }): Promise<MarketplaceCatalog> {
    const store = await readInstalledPluginStore(this.storePath);
    const result: MarketplaceCatalog = { sources: [], entries: [] };
    for (const source of await this.repository.sources()) {
      if (!source.enabled) {
        result.sources.push(source);
        continue;
      }
      const loaded = await this.repository.loadSource(source, input.refresh);
      result.sources.push({
        ...source,
        ...(loaded.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
        ...(loaded.stale ? { stale: true } : {}),
        ...(loaded.error ? { error: loaded.error } : {}),
      });
      for (const plugin of loaded.document?.plugins ?? []) {
        const installed = store.plugins[`user::${plugin.id}`];
        const incompatibility = await this.incompatible(plugin);
        let updateAvailable = false;
        if (
          installed?.provenance?.sourceId === source.id &&
          installed.provenance.catalogUrl === source.url
        )
          try {
            updateAvailable =
              compareMarketplaceVersions(
                plugin.version,
                installed.currentVersion,
              ) > 0;
          } catch {
            /* Legacy arbitrary versions are not automatically ordered. */
          }
        result.entries.push({
          sourceId: source.id,
          plugin,
          ...(installed
            ? {
                installedVersion: installed.currentVersion,
                ...(installed.provenance
                  ? { installedSourceId: installed.provenance.sourceId }
                  : {}),
              }
            : {}),
          updateAvailable,
          compatible: !incompatibility,
          ...(incompatibility ? { incompatibility } : {}),
        });
      }
    }
    return result;
  }
  async preview(input: MarketplaceSelection): Promise<MarketplacePreview> {
    for (const candidate of [...this.candidates.values()])
      if (candidate.expiresAt <= this.now()) await this.cancel(candidate.id);
    if (this.candidates.size >= 16)
      throw new Error("待确认的插件过多，请先完成或取消已有安装。");
    const source = await this.repository.activeSource(input.sourceId);
    const loaded = await this.repository.loadSource(source);
    if (!loaded.document || loaded.stale)
      throw new Error(loaded.error ?? "当前插件源不可用，不能开始新的安装。");
    const plugin = loaded.document.plugins.find(
      (x) => x.id === input.pluginId && x.version === input.version,
    );
    if (!plugin) throw new Error("插件版本已变更，请刷新市场后重新选择。");
    const incompatibility = await this.incompatible(plugin);
    if (incompatibility) throw new Error(incompatibility);
    const archive = await this.repository.download(source, plugin);
    let resolved:
      Awaited<ReturnType<typeof resolveLocalPluginArchive>> | undefined;
    try {
      resolved = await resolveLocalPluginArchive(archive.path);
      if (resolved.archiveDigest !== plugin.artifact.sha256)
        throw new Error("插件包摘要不匹配。");
      const validation = await validateNativePlugin(resolved.candidateRoot);
      if (validation.status !== "valid" || !validation.plugin)
        throw new Error(
          validation.diagnostics.map((x) => x.message).join("; "),
        );
      const manifest = validation.plugin.manifest;
      if (
        manifest.id !== plugin.id ||
        manifest.name !== plugin.name ||
        manifest.version !== plugin.version
      )
        throw new Error("实际插件身份与市场目录不一致。");
      const loadedPlugin = await loadNativePlugin(validation.plugin);
      if (loadedPlugin.diagnostics.some((x) => x.severity === "error"))
        throw new Error("插件组件校验失败。");
      const store = await readInstalledPluginStore(this.storePath);
      if (
        Object.values(store.plugins).some(
          (x) => x.id === plugin.id && x.scope === "managed",
        )
      )
        throw new Error("受管理插件不能被市场替换。");
      const previous = store.plugins[`user::${plugin.id}`];
      const replacementRequired = Boolean(
        previous &&
        (previous.linkedSourcePath ||
          previous.provenance?.sourceId !== source.id ||
          previous.provenance.catalogUrl !== source.url),
      );
      const requested = requestedPluginPermissions(manifest);
      const id = randomUUID();
      const captured = resolved;
      const candidate: Candidate = {
        id,
        cwd: input.cwd,
        source,
        plugin,
        requested,
        behaviorDigest: await computePluginBehaviorDigest(
          captured.candidateRoot,
        ),
        root: captured.candidateRoot,
        expiresAt: this.now() + MARKETPLACE_LIMITS.candidateMs,
        cleanup: async () => {
          await captured.cleanup();
          await archive.cleanup();
        },
      };
      this.candidates.set(id, candidate);
      const expiry = setTimeout(() => {
        if (this.candidates.get(id) === candidate)
          void this.cancel(id).catch(() => {});
      }, MARKETPLACE_LIMITS.candidateMs);
      expiry.unref();
      return {
        candidateId: id,
        identity: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.displayName
            ? { displayName: manifest.displayName }
            : {}),
        },
        requestedPermissions: requested,
        replacementRequired,
        approvalRequired:
          replacementRequired ||
          requested.some((x) => !previous?.approvedPermissions.includes(x)),
        sourceName: source.name,
      };
    } catch (error) {
      await resolved?.cleanup();
      await archive.cleanup();
      throw error;
    }
  }
  async cancel(id: string) {
    const candidate = this.candidates.get(id);
    if (candidate?.busy) candidate.cancelled = true;
    else if (candidate) {
      this.candidates.delete(id);
      await candidate.cleanup();
    }
    return { cancelled: true as const };
  }
  async operation(id: string): Promise<MarketplaceOperation> {
    const operations = (await readInstalledPluginStore(this.storePath))
      .installOperations;
    const stored =
      operations && Object.hasOwn(operations, id) ? operations[id] : undefined;
    if (!stored || this.now() - Date.parse(stored.updatedAt) >= 7 * 86400_000)
      return {
        operationId: id,
        status: "unknown",
        message: "安装结果暂时无法确认，请刷新插件列表。",
      };
    const {
      fingerprint: _fingerprint,
      updatedAt: _updatedAt,
      ...result
    } = stored;
    if (stored.status === "pending" && !this.running.has(id))
      return {
        ...result,
        status: "unknown",
        message: "原安装已中断，请刷新插件列表核对；未自动重复安装。",
      };
    return result;
  }
  async install(input: MarketplaceInstallInput): Promise<MarketplaceOperation> {
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(input.operationId))
      throw new Error("安装操作标识无效。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          cwd: input.cwd,
          candidateId: input.candidateId,
          permissions: [...input.approvedPermissions].sort(),
          allowSourceChange: input.allowSourceChange === true,
        }),
      )
      .digest("hex");
    const operations = (await readInstalledPluginStore(this.storePath))
      .installOperations;
    const existing =
      operations && Object.hasOwn(operations, input.operationId)
        ? operations[input.operationId]
        : undefined;
    if (existing && existing.fingerprint !== fingerprint)
      throw new Error("同一安装操作不能用于其他请求。");
    if (existing) return this.operation(input.operationId);
    const inFlight = this.running.get(input.operationId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint)
        throw new Error("同一安装操作不能用于其他请求。");
      return inFlight.promise;
    }
    const pending = this.installCandidate(input, fingerprint);
    this.running.set(input.operationId, { fingerprint, promise: pending });
    try {
      return await pending;
    } finally {
      this.running.delete(input.operationId);
    }
  }
  private async installCandidate(
    input: MarketplaceInstallInput,
    fingerprint: string,
  ): Promise<MarketplaceOperation> {
    const candidate = this.candidates.get(input.candidateId);
    const base = {
      operationId: input.operationId,
      fingerprint,
      updatedAt: new Date(this.now()).toISOString(),
      ...(candidate
        ? { pluginId: candidate.plugin.id, version: candidate.plugin.version }
        : {}),
    };
    const save = async (result: MarketplaceOperation) => {
      await updateInstalledPluginStore(this.storePath, (store) => {
        store.installOperations ??= {};
        store.installOperations[input.operationId] = { ...base, ...result };
        prunePluginInstallOperations(store, this.now());
      });
      return result;
    };
    if (candidate?.busy)
      return save({
        ...base,
        status: "failed",
        code: "plugin_marketplace_candidate_busy",
        message: "此安装预览已有请求正在处理，请查看原操作结果。",
      });
    if (candidate) candidate.busy = true;
    try {
      if (
        !candidate ||
        candidate.cwd !== input.cwd ||
        candidate.expiresAt <= this.now()
      )
        throw new Error("安装预览已失效，请重新选择插件。");
      const active = await this.repository.activeSource(candidate.source.id);
      if (active.url !== candidate.source.url)
        throw new Error("插件源地址已变更。");
      const incompatible = await this.incompatible(candidate.plugin);
      if (incompatible) throw new Error(incompatible);
      if (
        (await computePluginBehaviorDigest(candidate.root)) !==
        candidate.behaviorDigest
      )
        throw new Error("候选插件内容发生变化，请重新预览。");
      const current = (await readInstalledPluginStore(this.storePath)).plugins[
        `user::${candidate.plugin.id}`
      ];
      const sourceChanged =
        current &&
        (current.linkedSourcePath ||
          current.provenance?.sourceId !== active.id ||
          current.provenance.catalogUrl !== active.url);
      if (sourceChanged && !input.allowSourceChange)
        throw new Error("更换插件来源需要明确确认。");
      const supplied = [...new Set(input.approvedPermissions)].sort();
      const exact =
        supplied.length === candidate.requested.length &&
        supplied.every((x, i) => x === candidate.requested[i]);
      const reuse =
        supplied.length === 0 &&
        !sourceChanged &&
        candidate.requested.every((x) =>
          current?.approvedPermissions.includes(x),
        );
      if (!exact && !reuse) throw new Error("请确认实际插件请求的全部权限。");
      await save({ ...base, status: "pending", message: "正在安装插件。" });
      if (candidate.cancelled)
        throw new Error("此安装已取消，或插件源已停用。");
      const provenance: MarketplaceProvenance = {
        sourceId: active.id,
        catalogUrl: active.url,
        version: candidate.plugin.version,
        archiveDigest: candidate.plugin.artifact.sha256,
        ...candidate.plugin.source,
      };
      const operation: StoredPluginInstallOperation = {
        ...base,
        status: "installed",
        message: "插件已安装，将在新对话中生效。",
      };
      const result = await installLocalNativePlugin({
        cwd: candidate.cwd,
        sourcePath: candidate.root,
        scope: "user",
        approvedPermissions: [...candidate.requested],
        provenance,
        operation,
        reuseApprovedPermissions: reuse && !exact,
        allowSourceChange: input.allowSourceChange,
        storePath: this.storePath,
        cacheDir: this.options.cacheDir ?? getPluginCacheDir(),
        validateBeforeCommit: async () => {
          const latest = await this.repository.activeSource(
            candidate.source.id,
          );
          if (
            latest.url !== candidate.source.url ||
            candidate.cancelled ||
            candidate.expiresAt <= this.now()
          )
            throw new Error("安装已取消、预览到期或来源已变更，请重新选择。");
        },
      });
      if (result.status !== "installed")
        throw new Error(result.diagnostics.map((x) => x.message).join("; "));
      candidate.busy = false;
      await this.cancel(candidate.id);
      return this.operation(input.operationId);
    } catch (error) {
      const committed = (await readInstalledPluginStore(this.storePath))
        .installOperations?.[input.operationId];
      if (committed?.status === "installed")
        return this.operation(input.operationId);
      return save({
        ...base,
        status: "failed",
        code: "plugin_marketplace_install_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (candidate) {
        candidate.busy = false;
        if (candidate.cancelled) await this.cancel(candidate.id);
      }
    }
  }
}
