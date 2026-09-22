import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInstalledPluginStorePath, getPluginCacheDir } from "@openharness/core";
import { readInstalledPluginStore, updateInstalledPluginStore } from "@openharness/plugins";
import { createDefaultPluginService, PluginArchiveFailure } from "./plugin-service.js";

const { nativeToolRuntimeSnapshot } = vi.hoisted(() => ({
  nativeToolRuntimeSnapshot: vi.fn(() => ({
    state: "inactive" as const,
    hostCount: 0,
    registeredToolCount: 0,
    toolNames: [],
  })),
}));

vi.mock("@openharness/agent-runtime", () => ({
  getNativeToolRuntimeSnapshot: nativeToolRuntimeSnapshot,
}));

let root: string;
let scopedTmpdir: string;
let previousConfigDir: string | undefined;
let previousTempEnv: { TEMP?: string; TMP?: string; TMPDIR?: string };

beforeEach(async () => {
  // 解析器把临时目录建在全局共享的 os.tmpdir() 下；把本用例收窄到独立作用域，
  // 避免并行运行的其它包留下的 oh-plugin-zip-* 目录污染 residue 断言。
  scopedTmpdir = await mkdtemp(join(tmpdir(), "ohs-plugin-service-tmp-"));
  previousTempEnv = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TEMP = scopedTmpdir;
  process.env.TMP = scopedTmpdir;
  process.env.TMPDIR = scopedTmpdir;
  root = await mkdtemp(join(tmpdir(), "ohs-plugin-service-"));
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  process.env.OPENHARNESS_CONFIG_DIR = join(root, "config");
  nativeToolRuntimeSnapshot.mockReturnValue({
    state: "inactive",
    hostCount: 0,
    registeredToolCount: 0,
    toolNames: [],
  });
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  if (previousTempEnv.TEMP === undefined) delete process.env.TEMP;
  else process.env.TEMP = previousTempEnv.TEMP;
  if (previousTempEnv.TMP === undefined) delete process.env.TMP;
  else process.env.TMP = previousTempEnv.TMP;
  if (previousTempEnv.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTempEnv.TMPDIR;
  await rm(root, { recursive: true, force: true });
  await rm(scopedTmpdir, { recursive: true, force: true });
});

function service() {
  return createDefaultPluginService({ current: {
    model: "test",
    apiFormat: "anthropic",
    maxTurns: 1,
    permission: { mode: "default" },
  } });
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function writeArchive(name: string, files: Record<string, string>): Promise<string> {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const filename = Buffer.from(path);
    const contents = Buffer.from(source);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, contents);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(contents.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += local.length + filename.length + contents.length;
  }
  const centralSize = central.reduce((size, item) => size + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  const archive = join(root, name);
  await writeFile(archive, Buffer.concat([...locals, ...central, end]));
  return archive;
}

async function writeNativeArchive(name = "plugin.zip", overrides: Record<string, string> = {}): Promise<string> {
  return await writeArchive(name, {
    ".openharness-plugin/plugin.json": JSON.stringify({
      schemaVersion: 1,
      id: "dev.openharness.archive",
      name: "archive",
      version: "1.0.0",
      components: { tools: ["./tools/not-executed.js"] },
    }),
    "tools/not-executed.js": "throw new Error('Tool code must not run during archive preview');",
    ...overrides,
  });
}

async function writeTarArchive(
  name: string,
  files: Record<string, string>,
  gzip = false,
): Promise<string> {
  const chunks: Buffer[] = [];
  for (const [path, source] of Object.entries(files)) {
    const contents = Buffer.from(source);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = join(root, name);
  const tar = Buffer.concat(chunks);
  await writeFile(archive, gzip ? gzipSync(tar) : tar);
  return archive;
}

async function writeNativeTarArchive(name: string, gzip = false): Promise<string> {
  return await writeTarArchive(name, {
    ".openharness-plugin/plugin.json": JSON.stringify({
      schemaVersion: 1,
      id: "dev.openharness.archive",
      name: "archive",
      version: "1.0.0",
      components: { tools: ["./tools/not-executed.js"] },
    }),
    "tools/not-executed.js": "throw new Error('Tool code must not run during archive preview');",
  }, gzip);
}

function permissionManifest(version: string, includeNetwork = false): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "dev.openharness.archive",
    name: "archive",
    version,
    permissions: {
      process: ["spawn"],
      ...(includeNetwork ? { network: ["api.example.com"] } : {}),
    },
    components: {
      tools: [{ entry: "./tools/not-executed.js", permissions: ["process.spawn"] }],
    },
  });
}

function archiveFailureCode(error: unknown): string | undefined {
  return error instanceof PluginArchiveFailure ? error.body.code : undefined;
}

async function resolverRoots(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("oh-plugin-zip-"));
}

async function installPreviewedArchive(archive: string): Promise<void> {
  const plugins = service() as any;
  const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
  await plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: archive,
    expectedArchiveDigest: preview.archiveDigest,
    approvedPermissions: preview.requestedPermissions,
  });
}

describe("default plugin service user scope", () => {
  it("marks an unverifiable copied user installation invalid without loading its contributions", async () => {
    const pluginDir = join(root, "cache", "dev.example.unverifiable");
    await mkdir(join(pluginDir, ".openharness-plugin"), { recursive: true });
    await mkdir(join(pluginDir, "skills", "unverifiable"), { recursive: true });
    await writeFile(join(pluginDir, ".openharness-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "dev.example.unverifiable",
      name: "unverifiable",
      version: "1.0.0",
      components: { skills: ["./skills"] },
    }));
    await writeFile(join(pluginDir, "skills", "unverifiable", "SKILL.md"), "---\nname: unverifiable\ndescription: fixture\n---\nDo not load.\n");
    await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
      store.plugins["user::dev.example.unverifiable"] = {
        id: "dev.example.unverifiable",
        scope: "user",
        enabled: true,
        currentVersion: "1.0.0",
        cachePath: pluginDir,
        origin: "native",
        requestedPermissions: [],
        approvedPermissions: [],
        installedAt: "now",
        updatedAt: "now",
      };
    });

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]).toMatchObject({
      installation: "invalid",
      inventory: {},
      runtimeStatus: {
        state: "failed",
        code: "snapshot_missing",
        message: "加载失败：插件文件不完整，请重新导入插件包。",
        action: "reimport",
      },
      diagnostics: [{ code: "plugin_content_digest_missing" }],
    });
  });

  it("marks an enabled valid plugin pending reload until a tool runtime is active", async () => {
    await installPreviewedArchive(await writeNativeArchive("pending.zip"));

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "pending_reload",
      message: "已启用，下一次对话生效。",
      action: "reload",
    });
  });

  it("marks a disabled plugin disabled even when it is otherwise valid", async () => {
    await installPreviewedArchive(await writeNativeArchive("disabled.zip"));
    await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
      for (const record of Object.values(store.plugins)) record.enabled = false;
    });

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "disabled",
      message: "插件已停用。",
      action: "enable",
    });
  });

  it("marks digest drift as a reimportable runtime failure", async () => {
    await installPreviewedArchive(await writeNativeArchive("digest.zip"));
    const record = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]!;
    await writeFile(join(record.cachePath, "tools", "not-executed.js"), "export default 'tampered';");

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "failed",
      code: "snapshot_tampered",
      message: "加载失败：插件文件与安装记录不一致，请重新导入插件包。",
      action: "reimport",
    });
  });

  it("marks unsupported component warnings as degraded", async () => {
    await installPreviewedArchive(await writeNativeArchive("warning-list.zip", {
      ".openharness-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1,
        id: "dev.openharness.archive",
        name: "archive",
        version: "1.0.0",
        components: { workflows: ["./workflows/workflow.yml"] },
      }),
      "workflows/workflow.yml": "name: unsupported-but-safe\n",
    }));

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "degraded",
      code: "component_unsupported",
      message: "部分能力不可用：当前版本暂不支持该组件。",
      action: "details",
    });
  });

  it("marks a valid plugin loaded when its native tool runtime is active", async () => {
    nativeToolRuntimeSnapshot.mockReturnValue({
      state: "active",
      hostCount: 1,
      registeredToolCount: 1,
      toolNames: ["ArchiveTool"],
      lastStartedAt: "2026-09-14T00:00:00.000Z",
    });
    await installPreviewedArchive(await writeNativeArchive("loaded.zip"));

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "loaded",
      message: "插件已加载。",
      action: "none",
    });
  });

  it("marks a degraded native tool runtime as degraded instead of pending reload", async () => {
    nativeToolRuntimeSnapshot.mockReturnValue({
      state: "degraded",
      hostCount: 1,
      registeredToolCount: 0,
      toolNames: [],
      lastError: "tool host reported degraded",
    });
    await installPreviewedArchive(await writeNativeArchive("tool-runtime-degraded.zip"));

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins[0]?.runtimeStatus).toEqual({
      state: "degraded",
      code: "tool_host_degraded",
      message: "部分能力不可用：插件工具进程状态异常，请查看详情。",
      action: "details",
    });
  });
});

describe("default plugin service archive imports", () => {
  it("previews a real ZIP without executing Node Tool code", async () => {
    const archive = await writeNativeArchive();

    await expect((service() as any).previewArchive({ cwd: "C:/workspace", archivePath: archive })).resolves.toMatchObject({
      identity: { id: "dev.openharness.archive", name: "archive", version: "1.0.0" },
      requestedPermissions: [],
      approvalRequired: false,
      inventory: { tools: 1 },
      diagnostics: [],
    });
  });

  it.each([
    ["TAR", "plugin.tar", false],
    ["TAR.GZ", "plugin.tar.gz", true],
  ] as const)("previews and installs a real %s archive", async (_label, name, gzip) => {
    const archive = await writeNativeTarArchive(name, gzip);
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });

    expect(preview).toMatchObject({
      identity: { id: "dev.openharness.archive", name: "archive", version: "1.0.0" },
      requestedPermissions: [],
      approvalRequired: false,
      inventory: { tools: 1 },
    });
    await expect(plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: preview.archiveDigest,
      approvedPermissions: [],
    })).resolves.toMatchObject({ message: "Installed plugin 'dev.openharness.archive'." });
  });

  it("installs the immutable ZIP snapshot only when preview digest and approvals still match", async () => {
    const archive = await writeNativeArchive();
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });

    await expect(plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: preview.archiveDigest,
      approvedPermissions: [],
    })).resolves.toMatchObject({ message: "Installed plugin 'dev.openharness.archive'." });
    const record = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0];
    expect(record).toMatchObject({ id: "dev.openharness.archive", scope: "user" });
    expect(record).not.toHaveProperty("linkedSourcePath");
    expect(record?.cachePath).toContain("dev.openharness.archive");
    await writeNativeArchive("plugin.zip", { "tools/not-executed.js": "export default 'changed archive';" });
    await expect(readFile(join(record!.cachePath, "tools", "not-executed.js"), "utf8")).resolves.toContain("must not run");
  });

  it("rejects missing and unknown permission approvals before store mutation", async () => {
    const archive = await writeNativeArchive("permissions.zip", {
      ".openharness-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1, id: "dev.openharness.archive", name: "archive", version: "1.0.0",
        permissions: { process: ["spawn"] },
        components: { tools: [{ entry: "./tools/not-executed.js", permissions: ["process.spawn"] }] },
      }),
    });
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(preview.requestedPermissions).toEqual(["process:spawn", "tool:process.spawn"]);
    expect(preview.approvalRequired).toBe(true);

    for (const approvedPermissions of [[], ["process:spawn", "tool:process.spawn", "network:example"]]) {
      await expect(plugins.installArchive({ cwd: "C:/workspace", archivePath: archive, expectedArchiveDigest: preview.archiveDigest, approvedPermissions }))
        .rejects.toSatisfy((error: unknown) => archiveFailureCode(error) === "plugin_archive_permissions_not_approved");
    }
    expect(Object.keys((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)).toEqual([]);
  });

  it("reuses previous approval when reinstalling with the same permissions", async () => {
    const archive = await writeNativeArchive("same-permissions.zip", {
      ".openharness-plugin/plugin.json": permissionManifest("1.0.0"),
    });
    const plugins = service() as any;
    const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(firstPreview.approvalRequired).toBe(true);
    await plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: firstPreview.archiveDigest,
      approvedPermissions: firstPreview.requestedPermissions,
    });

    const secondPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(secondPreview.approvalRequired).toBe(false);
    await expect(plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: secondPreview.archiveDigest,
      approvedPermissions: [],
    })).resolves.toMatchObject({ message: "Installed plugin 'dev.openharness.archive'." });
  });

  it("reuses previous approval when reinstalling with fewer permissions", async () => {
    const archive = await writeNativeArchive("fewer-permissions.zip", {
      ".openharness-plugin/plugin.json": permissionManifest("1.0.0", true),
    });
    const plugins = service() as any;
    const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: firstPreview.archiveDigest,
      approvedPermissions: firstPreview.requestedPermissions,
    });

    await writeNativeArchive("fewer-permissions.zip", {
      ".openharness-plugin/plugin.json": permissionManifest("1.1.0"),
    });
    const secondPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(secondPreview.approvalRequired).toBe(false);
    await plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: secondPreview.archiveDigest,
      approvedPermissions: [],
    });

    const record = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]!;
    expect(record.currentVersion).toBe("1.1.0");
    expect(record.approvedPermissions).toEqual(["process:spawn", "tool:process.spawn"]);
  });

  it("requires approval when a reinstall adds a permission", async () => {
    const archive = await writeNativeArchive("added-permission.zip", {
      ".openharness-plugin/plugin.json": permissionManifest("1.0.0"),
    });
    const plugins = service() as any;
    const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: firstPreview.archiveDigest,
      approvedPermissions: firstPreview.requestedPermissions,
    });

    await writeNativeArchive("added-permission.zip", {
      ".openharness-plugin/plugin.json": permissionManifest("1.1.0", true),
    });
    const secondPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(secondPreview.approvalRequired).toBe(true);
    await expect(plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: secondPreview.archiveDigest,
      approvedPermissions: [],
    })).rejects.toSatisfy(
      (error: unknown) => archiveFailureCode(error) === "plugin_archive_permissions_not_approved",
    );
    expect(Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]?.currentVersion).toBe("1.0.0");
  });

  it("keeps the previous record when archive contents drift before reinstall", async () => {
    const archive = await writeNativeArchive("failed-reinstall.zip");
    const plugins = service() as any;
    const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: firstPreview.archiveDigest,
      approvedPermissions: [],
    });
    const previous = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]!;

    const nextPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await writeNativeArchive("failed-reinstall.zip", {
      "tools/not-executed.js": "export default 'digest drift';",
    });
    await expect(plugins.installArchive({
      cwd: "C:/workspace",
      archivePath: archive,
      expectedArchiveDigest: nextPreview.archiveDigest,
      approvedPermissions: [],
    })).rejects.toSatisfy(
      (error: unknown) => archiveFailureCode(error) === "plugin_archive_changed",
    );
    const current = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]!;
    expect(current).toEqual(previous);
  });

  it("rejects a digest drift before it mutates the store", async () => {
    const archive = await writeNativeArchive("drift.zip");
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await writeNativeArchive("drift.zip", { "tools/not-executed.js": "export default 'changed';" });

    await expect(plugins.installArchive({ cwd: "C:/workspace", archivePath: archive, expectedArchiveDigest: preview.archiveDigest, approvedPermissions: [] }))
      .rejects.toSatisfy((error: unknown) => archiveFailureCode(error) === "plugin_archive_changed");
    expect(Object.keys((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)).toEqual([]);
  });

  it("refuses an archive that conflicts with a managed plugin ID", async () => {
    const archive = await writeNativeArchive("managed.zip");
    await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
      store.plugins["managed::dev.openharness.archive"] = {
        id: "dev.openharness.archive", scope: "managed", enabled: true, currentVersion: "1.0.0",
        cachePath: join(root, "managed-cache"), origin: "native", requestedPermissions: [], approvedPermissions: [],
        installedAt: "now", updatedAt: "now",
      };
    });
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });

    await expect(plugins.installArchive({ cwd: "C:/workspace", archivePath: archive, expectedArchiveDigest: preview.archiveDigest, approvedPermissions: [] }))
      .rejects.toSatisfy((error: unknown) => archiveFailureCode(error) === "plugin_archive_managed_conflict");
  });

  it("returns validation diagnostics and cleans extracted candidates after a failed preview", async () => {
    const before = await resolverRoots();
    const archive = await writeNativeArchive("invalid.zip", {
      ".openharness-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1, id: "dev.openharness.archive", name: "archive", version: "1.0.0",
        components: { skills: ["./missing"] },
      }),
    });

    await expect((service() as any).previewArchive({ cwd: "C:/workspace", archivePath: archive }))
      .rejects.toMatchObject({ body: { code: "plugin_archive_invalid", diagnostics: [expect.objectContaining({ code: "component_path_missing" })] } });
    expect(await resolverRoots()).toEqual(before);
  });

  it("returns a structured resolver failure for a corrupt ZIP", async () => {
    const archive = join(root, "corrupt.zip");
    await writeFile(archive, "not a ZIP");

    await expect((service() as any).previewArchive({ cwd: "C:/workspace", archivePath: archive }))
      .rejects.toMatchObject({ body: { code: "plugin_archive_invalid", diagnostics: [expect.objectContaining({ code: "plugin_archive_resolution_failed" })] } });
  });

  it("keeps warning-level unsupported diagnostics visible while allowing installation", async () => {
    const archive = await writeNativeArchive("warning.zip", {
      ".openharness-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1, id: "dev.openharness.archive", name: "archive", version: "1.0.0",
        components: { workflows: ["./workflows/workflow.yml"] },
      }),
      "workflows/workflow.yml": "name: unsupported-but-safe\n",
    });
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    expect(preview.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "native_workflows_not_supported" }),
    ]));

    await expect(plugins.installArchive({ cwd: "C:/workspace", archivePath: archive, expectedArchiveDigest: preview.archiveDigest, approvedPermissions: [] }))
      .resolves.toMatchObject({ message: "Installed plugin 'dev.openharness.archive'." });
  });

  it("returns an installer failure and cleans the extracted candidate", async () => {
    const before = await resolverRoots();
    const archive = await writeNativeArchive("installer-failure.zip");
    const plugins = service() as any;
    const preview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
    await mkdir(getPluginCacheDir(), { recursive: true });
    await writeFile(join(getPluginCacheDir(), "dev.openharness.archive"), "blocks cache directory creation");

    await expect(plugins.installArchive({ cwd: "C:/workspace", archivePath: archive, expectedArchiveDigest: preview.archiveDigest, approvedPermissions: [] }))
      .rejects.toMatchObject({ body: { code: "plugin_archive_install_failed" } });
    expect(await resolverRoots()).toEqual(before);
  });
});
