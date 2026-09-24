import { access, copyFile, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveLocalPluginArchive, resolveLocalPluginZip } from "./index.js";

const temporaryRoots: string[] = [];
const manifest = ".vykor-plugin/plugin.json";

let scopedTmpdir: string;
let previousTempEnv: { TEMP?: string; TMP?: string; TMPDIR?: string };

beforeEach(async () => {
  // 解析器在全局共享的 os.tmpdir() 下建私有目录；收窄到独立作用域，避免与
  // 并行运行的其它包互相看到对方的 oh-plugin-zip-* 残留目录。
  scopedTmpdir = await mkdtemp(join(tmpdir(), "oh-plugin-source-tmp-"));
  previousTempEnv = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TEMP = scopedTmpdir;
  process.env.TMP = scopedTmpdir;
  process.env.TMPDIR = scopedTmpdir;
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousTempEnv.TEMP === undefined) delete process.env.TEMP;
  else process.env.TEMP = previousTempEnv.TEMP;
  if (previousTempEnv.TMP === undefined) delete process.env.TMP;
  else process.env.TMP = previousTempEnv.TMP;
  if (previousTempEnv.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTempEnv.TMPDIR;
  await rm(scopedTmpdir, { recursive: true, force: true });
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function temporaryArchive(name = "plugin.zip"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oh-plugin-source-test-"));
  temporaryRoots.push(root);
  return join(root, name);
}

async function writeZip(files: Record<string, string | Buffer>): Promise<string> {
  return await writeStoredZip(Object.entries(files).map(([name, content]) => ({ name, content, flags: 0x800 })));
}

async function writeTar(
  files: Record<string, string | Buffer | { type: "directory" | "symlink" | "fifo"; linkname?: string }>,
  options: { gzip?: boolean; name?: string } = {},
): Promise<string> {
  const chunks: Buffer[] = [];
  for (const [path, source] of Object.entries(files)) {
    const special = typeof source === "object" && !Buffer.isBuffer(source) && "type" in source ? source : undefined;
    const contents = special === undefined ? Buffer.from(source) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = (special?.type === "directory" ? "5" : special?.type === "symlink" ? "2" : special?.type === "fifo" ? "6" : "0").charCodeAt(0);
    if (special?.linkname) header.write(special.linkname, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = await temporaryArchive(options.name ?? (options.gzip ? "plugin.tar.gz" : "plugin.tar"));
  const tar = Buffer.concat(chunks);
  await writeFile(archive, options.gzip ? gzipSync(tar) : tar);
  return archive;
}

type StoredEntry = { name: string; content?: string | Buffer; externalAttributes?: number; crc?: number; declaredSize?: number; declaredCompressedSize?: number; flags?: number };

async function writeStoredZip(entries: StoredEntry[]): Promise<string> {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content ?? "");
    const crc = entry.crc ?? crc32(content);
    const declaredSize = entry.declaredSize ?? content.length;
    const declaredCompressedSize = entry.declaredCompressedSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(declaredCompressedSize, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(declaredCompressedSize, 20);
    header.writeUInt32LE(declaredSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + content.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = await temporaryArchive();
  await writeFile(archive, Buffer.concat([...locals, centralBytes, end]));
  return archive;
}

async function expectRejected(archive: string, message: RegExp): Promise<void> {
  await expect(resolveLocalPluginZip(archive)).rejects.toThrow(message);
}

it("resolves a root manifest, extracts real bytes, and cleanup removes only its private root", async () => {
  const archive = await writeZip({ [manifest]: '{"id":"example"}', "README.md": "hello" });
  const resolved = await resolveLocalPluginZip(archive);
  await expect(readFile(join(resolved.candidateRoot, "README.md"), "utf8")).resolves.toBe("hello");
  expect(resolved.archiveDigest).toMatch(/^[a-f0-9]{64}$/);
  const privateRoot = join(resolved.candidateRoot, "..");
  await resolved.cleanup();
  await expect(access(privateRoot)).rejects.toThrow();
});

it.each([
  ["tar", false, "plugin.tar"],
  ["tar.gz", true, "plugin.tar.gz"],
  ["tgz", true, "plugin.tgz"],
] as const)("resolves a local %s archive with the same root manifest rules", async (_label, gzip, name) => {
  const archive = await writeTar({ [manifest]: '{"id":"example"}', "README.md": "hello" }, { gzip, name });
  const resolved = await resolveLocalPluginArchive(archive);
  await expect(readFile(join(resolved.candidateRoot, "README.md"), "utf8")).resolves.toBe("hello");
  expect(resolved.archiveDigest).toMatch(/^[a-f0-9]{64}$/);
  await resolved.cleanup();
});

it("resolves a single wrapper directory only when every archive entry is inside it", async () => {
  const archive = await writeZip({
    "my-plugin/.vykor-plugin/plugin.json": '{"id":"example"}',
    "my-plugin/index.js": "export default 1;",
  });
  const resolved = await resolveLocalPluginZip(archive);
  expect(resolved.candidateRoot).toMatch(/[\\/]my-plugin$/);
  await resolved.cleanup();
});

it.each([
  ["a backslash path", `${manifest.replace("/", "\\")}`],
  ["an absolute path", `/${manifest}`],
  ["a drive path", `C:/${manifest}`],
  ["a NUL path", ".vykor-plugin/\0plugin.json"],
  ["a reserved Windows name", ".vykor-plugin/CON"],
  ["a colon segment", ".vykor-plugin/a:b"],
  ["a trailing-dot segment", ".vykor-plugin/file."],
  ["an empty segment", ".vykor-plugin//plugin.json"],
  ["a dot segment", ".vykor-plugin/./plugin.json"],
  ["a dot-dot segment", ".vykor-plugin/../plugin.json"],
] as const)("rejects %s before extraction", async (_label, name) => {
  await expectRejected(await writeStoredZip([{ name }]), /unsafe archive entry path|absolute path|invalid relative path|invalid characters|backslash/i);
});

it.each(["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$", "CLOCK$"])
("rejects Windows device name %s even when the archive has one valid manifest", async (deviceName) => {
  await expectRejected(
    await writeZip({ [manifest]: "{}", [deviceName]: "must not be extracted" }),
    /unsafe archive entry path/i,
  );
});

it("rejects entries longer than 1,024 UTF-8 bytes", async () => {
  await expectRejected(await writeStoredZip([{ name: `a/${"b".repeat(1024)}` }]), /path.*1,024/i);
});

it("rejects entries deeper than 32 directories", async () => {
  await expectRejected(await writeStoredZip([{ name: `${Array.from({ length: 33 }, () => "a").join("/")}/file` }]), /depth/i);
});

it("rejects NFC and case-insensitive duplicate paths", async () => {
  await expectRejected(await writeStoredZip([{ name: "café/file", flags: 0x800 }, { name: "café/file", flags: 0x800 }]), /duplicate|collision/i);
  await expectRejected(await writeStoredZip([{ name: "A/file" }, { name: "a/file" }]), /duplicate|collision/i);
  await expectRejected(await writeStoredZip([{ name: manifest }, { name: "A/one" }, { name: "a/two" }]), /duplicate|collision/i);
});

it("rejects a file-directory conflict", async () => {
  await expectRejected(await writeStoredZip([{ name: "node", content: "file" }, { name: "node/child", content: "child" }]), /file.*directory/i);
});

it("rejects a symlink and a special Unix entry type", async () => {
  await expectRejected(await writeStoredZip([{ name: manifest, externalAttributes: 0o120777 << 16 }]), /link|special/i);
  await expectRejected(await writeStoredZip([{ name: manifest, externalAttributes: 0o020666 << 16 }]), /special/i);
});

it("rejects encrypted central-directory entries", async () => {
  await expectRejected(await writeStoredZip([{ name: manifest, flags: 1 }]), /encrypted/i);
});

it("rejects declared archive limits before extraction", async () => {
  await expectRejected(await writeStoredZip([
    { name: manifest, content: "x", declaredSize: 90 * 1024 * 1024, declaredCompressedSize: 90 * 1024 * 1024 },
    { name: "a", content: "x", declaredSize: 90 * 1024 * 1024, declaredCompressedSize: 90 * 1024 * 1024 },
    { name: "b", content: "x", declaredSize: 90 * 1024 * 1024, declaredCompressedSize: 90 * 1024 * 1024 },
  ]), /250 MiB/i);
  await expectRejected(await writeStoredZip([{ name: manifest, content: "x", declaredSize: 101 * 1024 * 1024 }]), /single file.*100 MiB/i);
  await expectRejected(await writeStoredZip([{ name: manifest, content: "x", declaredSize: 201 }]), /compression ratio/i);
  await expectRejected(await writeStoredZip(Array.from({ length: 5001 }, (_, index) => ({ name: `file-${index}` }))), /5,000/i);
});

it("rejects archive directory-count bombs before extraction", async () => {
  await expectRejected(await writeStoredZip([
    { name: `${manifest}` },
    ...Array.from({ length: 5001 }, (_, index) => ({ name: `dir-${index}/` })),
  ]), /5,000/i);
  await expect(resolveLocalPluginArchive(await writeTar({
    [manifest]: "{}",
    ...Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`dir-${index}/`, { type: "directory" }])),
  }))).rejects.toThrow(/5,000/i);
});

it("rejects TAR symlinks and special entry types before extraction", async () => {
  await expect(resolveLocalPluginArchive(await writeTar({
    [manifest]: "{}",
    "link": { type: "symlink", linkname: "README.md" },
  }))).rejects.toThrow(/link|special/i);
  await expect(resolveLocalPluginArchive(await writeTar({
    [manifest]: "{}",
    "pipe": { type: "fifo" },
  }))).rejects.toThrow(/special/i);
});

it.each([
  ["an absolute path", `/${manifest}`],
  ["a dot-dot path", ".vykor-plugin/../plugin.json"],
  ["a trailing-space path", ".vykor-plugin/plugin.json "],
] as const)("rejects TAR %s before extraction", async (_label, name) => {
  await expect(resolveLocalPluginArchive(await writeTar({ [manifest]: "{}", [name]: "bad" }))).rejects.toThrow(/unsafe archive entry path/i);
});

it("rejects archives with zero, multiple, deep, or wrapper-escaping manifests", async () => {
  await expectRejected(await writeZip({ "index.js": "export {};" }), /exactly one manifest/i);
  await expectRejected(await writeZip({ [manifest]: "{}", "wrapped/.vykor-plugin/plugin.json": "{}" }), /exactly one manifest/i);
  await expectRejected(await writeZip({ "a/b/.vykor-plugin/plugin.json": "{}" }), /exactly one manifest/i);
  await expectRejected(await writeZip({ "wrapped/.vykor-plugin/plugin.json": "{}", "README.md": "outside" }), /outside/i);
});

it("rejects a truncated archive, a bad CRC, and a declared-versus-actual byte mismatch", async () => {
  const valid = await writeZip({ [manifest]: "{}" });
  const truncated = await temporaryArchive("truncated.zip");
  await writeFile(truncated, (await readFile(valid)).subarray(0, -8));
  await expectRejected(truncated, /end of central directory|unexpected end|invalid/i);
  await expectRejected(await writeStoredZip([{ name: manifest, content: "actual", crc: 0 }]), /CRC/i);
  await expectRejected(await writeStoredZip([{ name: manifest, content: "actual", declaredSize: 7 }]), /size|bytes/i);
});

it("rejects non-files and source files over 100 MiB before making a private copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-plugin-source-directory-"));
  temporaryRoots.push(directory);
  await expectRejected(directory, /regular file/i);
  const archive = await temporaryArchive("oversized.zip");
  await writeFile(archive, "x");
  await truncate(archive, 100 * 1024 * 1024 + 1);
  await expectRejected(archive, /100 MiB/i);
});

it("uses the copied archive bytes for stable SHA-256 digests", async () => {
  const first = await writeZip({ [manifest]: "{}", "index.js": "one" });
  const second = await temporaryArchive("same.zip");
  await copyFile(first, second);
  const changed = await writeZip({ [manifest]: "{}", "index.js": "two" });
  const a = await resolveLocalPluginZip(first);
  const b = await resolveLocalPluginZip(second);
  const c = await resolveLocalPluginZip(changed);
  expect(a.archiveDigest).toBe(b.archiveDigest);
  expect(c.archiveDigest).not.toBe(a.archiveDigest);
  await Promise.all([a.cleanup(), b.cleanup(), c.cleanup()]);
});

it("cleans its private directory when central-directory validation fails", async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("oh-plugin-zip-")));
  await expectRejected(await writeZip({ "index.js": "missing manifest" }), /exactly one manifest/i);
  const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("oh-plugin-zip-")));
  expect(after).toEqual(before);
});
