import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  MarketplaceRepository,
  isPublicMarketplaceAddress,
  allowsMarketplaceConnection,
  type MarketplaceRequest,
} from "../marketplace.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "market-source-test-"));
  roots.push(root);
  return root;
}
const body = Buffer.from("a plugin archive");
const plugin = {
  id: "example.notes-app",
  name: "notes-app",
  version: "1.0.2",
  category: "productivity",
  componentTypes: ["apps"],
  requires: { host: ">=1.2.20" },
  source: {
    repository: "https://github.com/rzx007/Vykor",
    commit: "a".repeat(40),
    path: "examples/plugins/notes-app",
  },
  artifact: {
    url: "https://plugins.example/notes.zip",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  },
};
const document = {
  schemaVersion: 1,
  id: "claims-official",
  name: "自定义源",
  owner: { name: "Example" },
  plugins: [plugin],
};
const response = (value: Buffer | object, status = 200, headers = {}) => ({
  status,
  headers,
  body: Readable.from([
    Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
  ]),
});

it("keeps source identity tied to URL, not the remote market name, and preserves cached entries offline", async () => {
  let offline = false;
  const request: MarketplaceRequest = async () => {
    if (offline) throw new Error("offline");
    return response(document);
  };
  const repo = new MarketplaceRepository({
    directory: await directory(),
    request,
  });
  const source = await repo.addSource(
    "https://plugins.example/marketplace.json",
  );
  expect(source.id).not.toBe(document.id);
  expect(source.builtin).toBe(false);
  expect((await repo.loadSource(source, true)).document?.plugins[0]?.id).toBe(
    plugin.id,
  );
  offline = true;
  const cached = await repo.loadSource(source, true);
  expect(cached.stale).toBe(true);
  expect(cached.document?.plugins).toHaveLength(1);
  await repo.setEnabled(source.id, false);
  expect((await repo.sources()).find((x) => x.id === source.id)?.enabled).toBe(
    false,
  );
  await repo.removeSource(source.id);
  expect((await repo.sources()).some((x) => x.id === source.id)).toBe(false);
});
it("downloads bounded verified bytes and rejects tampering", async () => {
  const repo = new MarketplaceRepository({
    directory: await directory(),
    request: async () => response(body),
  });
  const source = {
    id: "test",
    name: "test",
    url: "https://plugins.example/marketplace.json",
    builtin: false,
    enabled: true,
  };
  const archive = await repo.download(source, plugin);
  expect(await readFile(archive.path)).toEqual(body);
  await archive.cleanup();
  await expect(
    repo.download(source, {
      ...plugin,
      artifact: { ...plugin.artifact, sha256: "f".repeat(64) },
    }),
  ).rejects.toThrow(/摘要/);
  await expect(
    repo.download(source, {
      ...plugin,
      artifact: { ...plugin.artifact, size: 2 },
    }),
  ).rejects.toThrow(/大小/);
});
it("rejects cross-origin and unsafe redirects, even when the first request is allowed", async () => {
  const repo = new MarketplaceRepository({
    directory: await directory(),
    request: async () =>
      response(Buffer.alloc(0), 302, { location: "https://127.0.0.1/private" }),
  });
  const source = {
    id: "test",
    name: "test",
    url: "https://plugins.example/marketplace.json",
    builtin: false,
    enabled: true,
  };
  await expect(repo.download(source, plugin)).rejects.toThrow();
  await expect(
    repo.download(source, {
      ...plugin,
      artifact: { ...plugin.artifact, url: "https://other.example/file.zip" },
    }),
  ).rejects.toThrow();
});
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "172.18.0.2",
  "192.168.1.1",
  "100.64.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
  "0.0.0.0",
])("rejects private address %s", (address) =>
  expect(isPublicMarketplaceAddress(address)).toBe(false),
);
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
  "accepts public address %s",
  (address) => expect(isPublicMarketplaceAddress(address)).toBe(true),
);
it("supports benchmark-address proxy DNS only for the pinned builtin HTTPS source, without allowing private hosts", () => {
  expect(allowsMarketplaceConnection("198.18.0.4", true)).toBe(true);
  expect(allowsMarketplaceConnection("198.18.0.4", false)).toBe(false);
  expect(allowsMarketplaceConnection("127.0.0.1", true)).toBe(false);
  expect(allowsMarketplaceConnection("192.168.1.2", true)).toBe(false);
});
