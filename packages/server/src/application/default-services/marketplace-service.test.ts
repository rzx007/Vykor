import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MarketplaceRepository } from "@vykor/plugin-sources";
import {
  readInstalledPluginStore,
  withPluginInstallationLock,
} from "@vykor/plugins";
import { createMarketplaceService } from "./marketplace-service.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "market-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function zip(files: Record<string, string>) {
  let offset = 0;
  const parts: Buffer[] = [],
    central: Buffer[] = [];
  for (const [path, value] of Object.entries(files)) {
    const name = Buffer.from(path),
      body = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
async function fixture() {
  const archive = zip({
    ".vykor-plugin/plugin.json": JSON.stringify({
      schemaVersion: 1,
      id: "example.market",
      name: "market",
      version: "1.0.0",
      permissions: { network: ["https://example.com"] },
      components: { skills: ["./skills/demo"] },
    }),
    "skills/demo/SKILL.md":
      "---\nname: demo\ndescription: A useful skill\n---\nRead this note.\n",
  });
  const item = {
    id: "example.market",
    name: "market",
    version: "1.0.0",
    category: "productivity",
    componentTypes: ["skills"],
    artifact: {
      url: "https://plugins.example/plugin.zip",
      size: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
    requires: { host: ">=1.2.20" },
    source: {
      repository: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      path: "plugin",
    },
  };
  const repository = new MarketplaceRepository({
    directory: join(root, "sources"),
    request: async (url) => ({
      status: 200,
      headers: {},
      body: Readable.from([
        url.pathname.endsWith(".zip")
          ? archive
          : Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                id: "market",
                name: "Example",
                owner: { name: "Example" },
                plugins: [item],
              }),
            ),
      ]),
    }),
  });
  const source = await repository.addSource(
    "https://plugins.example/marketplace.json",
  );
  const options = {
    repository,
    storePath: join(root, "installed.json"),
    cacheDir: join(root, "cache"),
    hostVersion: "1.2.20",
    nodeVersion: "24.0.0",
  };
  const service = createMarketplaceService(options);
  const selection = {
    cwd: root,
    sourceId: source.id,
    pluginId: item.id,
    version: item.version,
  };
  return { service, options, repository, source, selection };
}
it("previews real permissions, rejects unapproved install, and commits a durable idempotent receipt", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  expect(preview.requestedPermissions).toEqual(["network:https://example.com"]);
  expect(preview.approvalRequired).toBe(true);
  const denied = await f.service.install({
    cwd: root,
    candidateId: preview.candidateId,
    operationId: "denied-operation",
    approvedPermissions: [],
  });
  expect(denied.status).toBe("failed");
  expect(
    Object.keys((await readInstalledPluginStore(f.options.storePath)).plugins),
  ).toHaveLength(0);
  const input = {
    cwd: root,
    candidateId: preview.candidateId,
    operationId: "valid-operation",
    approvedPermissions: preview.requestedPermissions,
  };
  const installed = await f.service.install(input);
  expect(installed.status).toBe("installed");
  const record = (await readInstalledPluginStore(f.options.storePath)).plugins[
    "user::example.market"
  ]!;
  expect(record.provenance?.sourceId).toBe(f.source.id);
  const restarted = createMarketplaceService(f.options);
  expect(await restarted.operation(input.operationId)).toMatchObject({
    status: "installed",
    pluginId: "example.market",
  });
  expect(await restarted.install(input)).toMatchObject({ status: "installed" });
  await expect(
    restarted.install({ ...input, cwd: join(root, "other") }),
  ).rejects.toThrow();
});
it("invalidates disabled-source and canceled candidates without touching plugin data", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  const data = join(root, "draft.txt");
  await writeFile(data, "unsaved app draft");
  await f.repository.setEnabled(f.source.id, false);
  expect(
    (
      await f.service.install({
        cwd: root,
        candidateId: preview.candidateId,
        operationId: "disabled-operation",
        approvedPermissions: preview.requestedPermissions,
      })
    ).status,
  ).toBe("failed");
  expect(await readFile(data, "utf8")).toBe("unsaved app draft");
  await f.repository.setEnabled(f.source.id, true);
  const second = await f.service.preview(f.selection);
  await f.service.cancel(second.candidateId);
  expect(
    (
      await f.service.install({
        cwd: root,
        candidateId: second.candidateId,
        operationId: "canceled-operation",
        approvedPermissions: second.requestedPermissions,
      })
    ).status,
  ).toBe("failed");
});
it("requires explicit source change even when both sources request identical permissions", async () => {
  const f = await fixture();
  const first = await f.service.preview(f.selection);
  await f.service.install({
    cwd: root,
    candidateId: first.candidateId,
    operationId: "first-operation",
    approvedPermissions: first.requestedPermissions,
  });
  const other = await f.repository.addSource(
    "https://plugins.example/another-index.json",
  );
  const next = await f.service.preview({ ...f.selection, sourceId: other.id });
  expect(next.replacementRequired).toBe(true);
  expect(next.approvalRequired).toBe(true);
  expect(
    (
      await f.service.install({
        cwd: root,
        candidateId: next.candidateId,
        operationId: "replacement-denied",
        approvedPermissions: next.requestedPermissions,
      })
    ).status,
  ).toBe("failed");
  expect(
    (
      await f.service.install({
        cwd: root,
        candidateId: next.candidateId,
        operationId: "replacement-allowed",
        approvedPermissions: next.requestedPermissions,
        allowSourceChange: true,
      })
    ).status,
  ).toBe("installed");
});
it("rejects operation ID reuse while an original request is still running", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  const input = {
    cwd: root,
    candidateId: preview.candidateId,
    operationId: "simultaneous-operation",
    approvedPermissions: preview.requestedPermissions,
  };
  const original = f.service.install(input);
  await expect(
    f.service.install({ ...input, cwd: join(root, "other") }),
  ).rejects.toThrow();
  expect((await original).status).toBe("installed");
});
it("does not return inherited object properties as operation receipts", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  await f.service.install({
    cwd: root,
    candidateId: preview.candidateId,
    operationId: "prototype-check-operation",
    approvedPermissions: preview.requestedPermissions,
  });
  expect((await f.service.operation("constructor")).status).toBe("unknown");
});
it("does not execute the same candidate twice under distinct operation IDs", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  const input = {
    cwd: root,
    candidateId: preview.candidateId,
    approvedPermissions: preview.requestedPermissions,
  };
  const results = await Promise.all([
    f.service.install({ ...input, operationId: "candidate-operation-one" }),
    f.service.install({ ...input, operationId: "candidate-operation-two" }),
  ]);
  expect(results.filter((x) => x.status === "installed")).toHaveLength(1);
});
it("rechecks cancellation after waiting for the installation lock before publishing a snapshot", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.selection);
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = withPluginInstallationLock(f.options.storePath, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const original = f.service.install({
    cwd: root,
    candidateId: preview.candidateId,
    operationId: "waiting-source-operation",
    approvedPermissions: preview.requestedPermissions,
  });
  try {
    for (let i = 0; i < 200; i++) {
      if (
        (await readInstalledPluginStore(f.options.storePath))
          .installOperations?.["waiting-source-operation"]?.status === "pending"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await f.service.setSourceEnabled(f.source.id, false);
  } finally {
    release();
  }
  await held;
  expect((await original).status).toBe("failed");
  expect((await readInstalledPluginStore(f.options.storePath)).plugins).toEqual(
    {},
  );
});
