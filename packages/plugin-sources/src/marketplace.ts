import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MARKETPLACE_LIMITS,
  normalizeMarketplaceUrl,
  parseMarketplaceDocument,
  type MarketplaceDocument,
  type MarketplacePlugin,
  type MarketplaceSource,
} from "@vykor/plugin-contracts/marketplace";

export const OFFICIAL_MARKETPLACE_SOURCE: MarketplaceSource = {
  id: "vykor-official",
  name: "Vykor 插件市场",
  url: "https://rzx007.github.io/vykor-plugins/marketplace.json",
  enabled: true,
  builtin: true,
};
export type MarketplaceRequest = (
  url: URL,
  context?: { builtin: boolean },
) => Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}>;
export interface LoadedMarketplaceSource {
  source: MarketplaceSource;
  document?: MarketplaceDocument;
  digest?: string;
  updatedAt?: string;
  stale?: boolean;
  error?: string;
}
const assetHosts = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export function isPublicMarketplaceAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    if (ip.startsWith("::ffff:")) {
      const tail = ip.slice(7);
      if (isIP(tail) === 4) return isPublicMarketplaceAddress(tail);
      const groups = tail.split(":");
      if (groups.length === 2) {
        const value =
          parseInt(groups[0]!, 16) * 65536 + parseInt(groups[1]!, 16);
        return isPublicMarketplaceAddress(
          [
            value >>> 24,
            (value >>> 16) & 255,
            (value >>> 8) & 255,
            value & 255,
          ].join("."),
        );
      }
    }
    // Globally routable unicast only; excludes loopback, mapped, ULA and link-local.
    return /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith("2001:db8:");
  }
  return false;
}
export function allowsMarketplaceConnection(
  address: string,
  builtin: boolean,
): boolean {
  // Some user-controlled TUN proxies map public DNS names into 198.18/15.
  // Only the pinned builtin HTTPS origins may use this mapping; TLS/SNI verification remains enabled.
  return (
    isPublicMarketplaceAddress(address) ||
    (builtin && /^198\.(18|19)\./.test(address) && isIP(address) === 4)
  );
}
function publicUrl(value: string): URL {
  const url = new URL(normalizeMarketplaceUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !isPublicMarketplaceAddress(host))
  )
    throw new Error("插件源不能访问本机或私有网络地址。");
  return url;
}
const requestPublic: MarketplaceRequest = (url, context) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        headers: {
          "User-Agent": "Vykor-Plugin-Marketplace",
          Accept: "application/json, application/zip, application/octet-stream",
        },
        lookup(hostname, options, callback) {
          void lookup(hostname, { all: true, verbatim: true })
            .then((addresses) => {
              if (
                !addresses.length ||
                addresses.some(
                  (x) =>
                    !allowsMarketplaceConnection(
                      x.address,
                      context?.builtin === true,
                    ),
                )
              )
                throw new Error("插件源 DNS 指向私有网络地址。");
              // Pin the checked address to this connection; do not resolve it a second time.
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            })
            .catch((error) => callback(error as NodeJS.ErrnoException, "", 4));
        },
      },
      (response) => {
        response.once("close", () => clearTimeout(deadline));
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        });
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("插件源请求超过三分钟。")),
      180_000,
    );
    deadline.unref();
    req.setTimeout(30_000, () => req.destroy(new Error("插件源连接超时。")));
    req.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.end();
  });
function assertSourceUrl(
  source: MarketplaceSource,
  value: string,
  redirect = false,
): URL {
  const url = publicUrl(value);
  if (url.origin === new URL(source.url).origin) return url;
  if (
    source.builtin &&
    source.id === OFFICIAL_MARKETPLACE_SOURCE.id &&
    source.url === OFFICIAL_MARKETPLACE_SOURCE.url
  ) {
    if (
      url.origin === "https://github.com" &&
      url.pathname.startsWith("/rzx007/vykor-plugins/releases/download/")
    )
      return url;
    if (redirect && assetHosts.has(url.hostname)) return url;
  }
  throw new Error("插件下载地址必须属于当前来源，不能跳转到其他来源。");
}
async function responseFrom(
  source: MarketplaceSource,
  value: string,
  request: MarketplaceRequest,
) {
  let url = assertSourceUrl(source, value);
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await request(url, {
      builtin:
        source.builtin &&
        source.id === OFFICIAL_MARKETPLACE_SOURCE.id &&
        source.url === OFFICIAL_MARKETPLACE_SOURCE.url,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.body.destroy();
      const location = response.headers.location;
      if (typeof location !== "string")
        throw new Error("插件源重定向缺少地址。");
      url = assertSourceUrl(source, new URL(location, url).href, true);
      continue;
    }
    if (response.status !== 200) {
      response.body.destroy();
      throw new Error(`插件源请求失败（HTTP ${response.status}）。`);
    }
    return response;
  }
  throw new Error("插件源重定向次数过多。");
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export class MarketplaceRepository {
  private readonly request: MarketplaceRequest;
  private readonly now: () => number;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      directory: string;
      request?: MarketplaceRequest;
      now?: () => number;
    },
  ) {
    this.request = options.request ?? requestPublic;
    this.now = options.now ?? Date.now;
  }
  private async settings(): Promise<MarketplaceSource[]> {
    try {
      const entries = JSON.parse(
        await readFile(join(this.options.directory, "sources.json"), "utf8"),
      ) as MarketplaceSource[];
      if (!Array.isArray(entries) || entries.length > 32)
        throw new Error("插件源配置无效。");
      return entries.map((entry) => {
        const url = publicUrl(entry.url).href;
        const builtin = url === OFFICIAL_MARKETPLACE_SOURCE.url;
        const expectedId = builtin
          ? OFFICIAL_MARKETPLACE_SOURCE.id
          : `source-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
        if (
          entry.id !== expectedId ||
          typeof entry.enabled !== "boolean" ||
          typeof entry.name !== "string"
        )
          throw new Error("插件源配置身份无效。");
        return { ...entry, url, builtin };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async sources(): Promise<MarketplaceSource[]> {
    const entries = await this.settings();
    return [
      entries.find((x) => x.id === OFFICIAL_MARKETPLACE_SOURCE.id) ?? {
        ...OFFICIAL_MARKETPLACE_SOURCE,
      },
      ...entries.filter((x) => x.id !== OFFICIAL_MARKETPLACE_SOURCE.id),
    ];
  }
  private mutate(
    change: (entries: MarketplaceSource[]) => MarketplaceSource[],
  ) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.options.directory, { recursive: true });
        await atomicJson(
          join(this.options.directory, "sources.json"),
          change(await this.sources()),
        );
      });
    this.writes = next;
    return next;
  }
  async addSource(value: string): Promise<MarketplaceSource> {
    const url = publicUrl(value).href;
    const source: MarketplaceSource = {
      id:
        url === OFFICIAL_MARKETPLACE_SOURCE.url
          ? OFFICIAL_MARKETPLACE_SOURCE.id
          : `source-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`,
      name: url,
      url,
      enabled: true,
      builtin: url === OFFICIAL_MARKETPLACE_SOURCE.url,
    };
    const loaded = await this.loadSource(source, true);
    if (!loaded.document || loaded.stale)
      throw new Error(loaded.error ?? "无法验证插件源。");
    source.name = loaded.document.name;
    await this.mutate((entries) => {
      if (entries.some((x) => x.id === source.id))
        throw new Error("这个插件源已经存在。");
      if (entries.length >= 32) throw new Error("插件源数量已达上限。");
      return [...entries, source];
    });
    return source;
  }
  async setEnabled(id: string, enabled: boolean) {
    await this.mutate((entries) => {
      if (!entries.some((x) => x.id === id)) throw new Error("插件源不存在。");
      return entries.map((x) => (x.id === id ? { ...x, enabled } : x));
    });
  }
  async removeSource(id: string) {
    await this.mutate((entries) => {
      const source = entries.find((x) => x.id === id);
      if (!source || source.builtin)
        throw new Error("默认插件源可停用，不能移除。");
      return entries.filter((x) => x.id !== id);
    });
  }
  async activeSource(id: string) {
    const source = (await this.sources()).find((x) => x.id === id && x.enabled);
    if (!source) throw new Error("插件源已停用或移除，请重新选择。");
    return source;
  }
  async loadSource(
    source: MarketplaceSource,
    refresh = false,
  ): Promise<LoadedMarketplaceSource> {
    const path = join(this.options.directory, `${source.id}.json`);
    let cached:
      | { document: MarketplaceDocument; digest: string; updatedAt: string }
      | undefined;
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      if (data.url === source.url)
        cached = {
          document: parseMarketplaceDocument(data.document),
          digest: data.digest,
          updatedAt: data.updatedAt,
        };
    } catch {
      /* A corrupt or absent cache is fetched again; never treated as a trusted candidate. */
    }
    if (
      !refresh &&
      cached &&
      this.now() - Date.parse(cached.updatedAt) < MARKETPLACE_LIMITS.cacheMs
    )
      return { source, ...cached };
    try {
      const response = await responseFrom(source, source.url, this.request);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MARKETPLACE_LIMITS.catalogBytes) {
          response.body.destroy();
          throw new Error("插件市场目录超过 2 MiB。");
        }
        chunks.push(buffer);
      }
      const content = Buffer.concat(chunks);
      const document = parseMarketplaceDocument(
        JSON.parse(content.toString("utf8")),
      );
      for (const plugin of document.plugins)
        assertSourceUrl(source, plugin.artifact.url);
      const result = {
        document,
        digest: createHash("sha256").update(content).digest("hex"),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await mkdir(this.options.directory, { recursive: true });
      await atomicJson(path, { url: source.url, ...result });
      return { source, ...result };
    } catch (error) {
      return {
        source,
        ...cached,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async download(
    source: MarketplaceSource,
    plugin: MarketplacePlugin,
  ): Promise<{ path: string; cleanup(): Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), "vykor-marketplace-"));
    const path = join(root, "plugin.zip");
    const cleanup = () => rm(root, { recursive: true, force: true });
    try {
      const response = await responseFrom(
        source,
        plugin.artifact.url,
        this.request,
      );
      const hash = createHash("sha256");
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (
            bytes > plugin.artifact.size ||
            bytes > MARKETPLACE_LIMITS.archiveBytes
          )
            return done(new Error("插件包大小不符合目录声明。"));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        response.body,
        limit,
        createWriteStream(path, { flags: "wx" }),
      );
      if (bytes !== plugin.artifact.size)
        throw new Error("插件包大小不符合目录声明。");
      if (hash.digest("hex") !== plugin.artifact.sha256)
        throw new Error("插件包摘要校验失败。");
      return { path, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
