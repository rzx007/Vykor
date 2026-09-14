import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as extractTarArchive, list as listTarArchive, type ReadEntry } from "tar";
import yauzl from "yauzl";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_PATH_BYTES = 1_024;
const MAX_DEPTH = 32;
const PRIVATE_PREFIX = "oh-plugin-zip-";
const MANIFEST_PATH = ".openharness-plugin/plugin.json";

export interface ResolvedLocalPluginZip {
  archiveDigest: string;
  candidateRoot: string;
  cleanup(): Promise<void>;
}

export type ResolvedLocalPluginArchive = ResolvedLocalPluginZip;

type LocalArchiveKind = "zip" | "tar" | "tar.gz";

interface PlannedEntry {
  entry: yauzl.Entry;
  path: string;
  directory: boolean;
}

interface TarEntry {
  path: string;
  directory: boolean;
  size: number;
}

class Crc32 {
  private value = 0xffffffff;

  update(chunk: Buffer): void {
    for (const byte of chunk) {
      this.value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) this.value = (this.value >>> 1) ^ (this.value & 1 ? 0xedb88320 : 0);
    }
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function archiveError(message: string): Error {
  return new Error(`Unsafe plugin archive: ${message}`);
}

function foldedPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function entryType(entry: yauzl.Entry): { directory: boolean; path: string } {
  const raw = entry.fileName;
  const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixType === 0xa000) throw archiveError(`symlink entry is not allowed: ${raw}`);
  if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) throw archiveError(`special entry type is not allowed: ${raw}`);
  const directory = raw.endsWith("/") || unixType === 0x4000;
  const path = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return { directory, path };
}

function validatePath(path: string): string[] {
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) throw archiveError("entry path exceeds 1,024 bytes");
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) throw archiveError(`entry path depth exceeds ${MAX_DEPTH}`);
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(":")) throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    if (segment.endsWith(".") || segment.endsWith(" ")) throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/i.test(segment)) {
      throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    }
  }
  return segments;
}

function validateEntries(entries: yauzl.Entry[]): PlannedEntry[] {
  const aliases = new Map<string, { path: string; direct: boolean }>();
  const files = new Set<string>();
  const directories = new Set<string>();
  const planned: PlannedEntry[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  for (const entry of entries) {
    entryCount += 1;
    if (entryCount > MAX_ENTRIES) throw archiveError(`archive contains more than ${MAX_ENTRIES.toLocaleString("en-US")} entries`);
    if ((entry.generalPurposeBitFlag & 1) !== 0) throw archiveError(`encrypted entry is not allowed: ${entry.fileName}`);
    const { directory, path } = entryType(entry);
    const segments = validatePath(path);
    const folded = foldedPath(path);
    const prior = aliases.get(folded);
    if (prior?.direct || (prior !== undefined && prior.path !== path)) {
      throw archiveError(`duplicate or NFC/case collision: ${prior.path} and ${path}`);
    }
    aliases.set(folded, { path, direct: true });

    if (!directory) {
      if (entry.uncompressedSize > MAX_FILE_BYTES) throw archiveError("single file exceeds 100 MiB");
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_EXTRACTED_BYTES) throw archiveError("archive extraction exceeds 250 MiB");
      if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)) {
        throw archiveError(`entry compression ratio exceeds ${MAX_COMPRESSION_RATIO}`);
      }
    }

    if (directory) {
      if (files.has(folded)) throw archiveError(`file-directory conflict at ${path}`);
      directories.add(folded);
    } else {
      if (directories.has(folded)) throw archiveError(`file-directory conflict at ${path}`);
      files.add(folded);
    }
    for (let length = 1; length < segments.length; length += 1) {
      const parentPath = segments.slice(0, length).join("/");
      const parent = foldedPath(parentPath);
      const parentAlias = aliases.get(parent);
      if (parentAlias !== undefined && parentAlias.path !== parentPath) {
        throw archiveError(`duplicate or NFC/case collision: ${parentAlias.path} and ${parentPath}`);
      }
      if (parentAlias === undefined) aliases.set(parent, { path: parentPath, direct: false });
      if (files.has(parent)) throw archiveError(`file-directory conflict at ${path}`);
      directories.add(parent);
    }
    planned.push({ entry, path, directory });
  }
  return planned;
}

function candidateWrapper(entries: readonly { path: string; directory: boolean }[]): string | undefined {
  const candidates = entries
    .filter((entry) => !entry.directory)
    .flatMap((entry) => {
      if (entry.path === MANIFEST_PATH) return [undefined];
      const segments = entry.path.split("/");
      return segments.length === 3 && segments[1] === ".openharness-plugin" && segments[2] === "plugin.json" ? [segments[0]] : [];
    });
  if (candidates.length !== 1) throw archiveError("archive must contain exactly one manifest at its root or under one wrapper directory");
  const wrapper = candidates[0];
  if (wrapper !== undefined && entries.some((entry) => entry.path !== wrapper && !entry.path.startsWith(`${wrapper}/`))) {
    throw archiveError(`wrapper archive contains an entry outside ${wrapper}`);
  }
  return wrapper;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) reject(error ?? archiveError("could not open ZIP")); else resolveZip(zip);
    });
  });
}

function closeQuietly(zip: yauzl.ZipFile): void {
  try { zip.close(); } catch { /* already closed */ }
}

function readCentralDirectory(path: string): Promise<yauzl.Entry[]> {
  return openZip(path).then((zip) => new Promise((resolveEntries, reject) => {
    const entries: yauzl.Entry[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      closeQuietly(zip);
      if (error) reject(error); else resolveEntries(entries);
    };
    zip.on("error", finish);
    zip.on("end", () => finish());
    zip.on("entry", (entry) => {
      entries.push(entry);
      try { zip.readEntry(); } catch (error) { finish(error as Error); }
    });
    try { zip.readEntry(); } catch (error) { finish(error as Error); }
  }));
}

async function copyAndHash(source: string, privateRoot: string): Promise<{ path: string; digest: string }> {
  const target = join(privateRoot, "source.archive");
  const hash = createHash("sha256");
  let copied = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      if (copied > MAX_SOURCE_BYTES) callback(archiveError("source archive exceeds 100 MiB"));
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  await pipeline(createReadStream(source), counter, createWriteStream(target, { flags: "wx" }));
  return { path: target, digest: hash.digest("hex") };
}

function extractFile(zip: yauzl.ZipFile, entry: yauzl.Entry, destination: string): Promise<void> {
  return new Promise((resolveFile, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError || !stream) { reject(openError ?? archiveError(`could not read ${entry.fileName}`)); return; }
      const crc = new Crc32();
      let bytes = 0;
      const output = createWriteStream(destination, { flags: "wx" });
      const fail = (error: Error) => { stream.destroy(); output.destroy(); reject(error); };
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > MAX_FILE_BYTES) fail(archiveError(`actual byte count exceeds declared size for ${entry.fileName}`));
        else crc.update(chunk);
      });
      stream.on("error", (error) => reject(error));
      output.on("error", (error) => reject(error));
      output.on("finish", () => {
        if (bytes !== entry.uncompressedSize) reject(archiveError(`actual byte count does not match declared size for ${entry.fileName}`));
        else if (crc.digest() !== (entry.crc32 >>> 0)) reject(archiveError(`CRC mismatch for ${entry.fileName}`));
        else resolveFile();
      });
      stream.pipe(output);
    });
  });
}

function extractEntries(path: string, destination: string, planned: PlannedEntry[]): Promise<void> {
  return openZip(path).then((zip) => new Promise((resolveExtraction, reject) => {
    let index = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      closeQuietly(zip);
      if (error) reject(error); else resolveExtraction();
    };
    zip.on("error", finish);
    zip.on("end", () => index === planned.length ? finish() : finish(archiveError("ZIP entry list changed during extraction")));
    zip.on("entry", async (entry) => {
      try {
        const expected = planned[index++];
        if (!expected || expected.entry.fileName !== entry.fileName) throw archiveError("ZIP entry list changed during extraction");
        const target = join(destination, ...expected.path.split("/"));
        if (expected.directory) await mkdir(target, { recursive: true });
        else { await mkdir(dirname(target), { recursive: true }); await extractFile(zip, entry, target); }
        zip.readEntry();
      } catch (error) { finish(error as Error); }
    });
    try { zip.readEntry(); } catch (error) { finish(error as Error); }
  }));
}

function localArchiveKind(source: string): LocalArchiveKind {
  const lower = source.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  throw archiveError("supported formats are ZIP, TAR, TAR.GZ, and TGZ");
}

function tarEntryInfo(entry: ReadEntry): TarEntry {
  const rawPath = entry.path;
  if (entry.type === "SymbolicLink" || entry.type === "Link") throw archiveError(`link entry is not allowed: ${rawPath}`);
  const directory = entry.type === "Directory" || rawPath.endsWith("/");
  if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
    throw archiveError(`special entry type is not allowed: ${rawPath}`);
  }
  if (directory && entry.size > 0) throw archiveError(`directory entry has unexpected content: ${rawPath}`);
  const path = directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  validatePath(path);
  return { path, directory, size: entry.size };
}

async function readTarEntries(path: string, gzip: boolean): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  let totalBytes = 0;
  let failure: Error | undefined;
  await listTarArchive({
    file: path,
    gzip,
    strict: true,
    preservePaths: true,
    maxDecompressionRatio: MAX_COMPRESSION_RATIO,
    onReadEntry(entry) {
      if (failure) {
        entry.ignore = true;
        return;
      }
      try {
        if (entries.length >= MAX_ENTRIES) throw archiveError(`archive contains more than ${MAX_ENTRIES.toLocaleString("en-US")} entries`);
        const planned = tarEntryInfo(entry);
        if (!planned.directory) {
          if (planned.size > MAX_FILE_BYTES) throw archiveError("single file exceeds 100 MiB");
          totalBytes += planned.size;
          if (totalBytes > MAX_EXTRACTED_BYTES) throw archiveError("archive extraction exceeds 250 MiB");
        }
        entries.push(planned);
      } catch (error) {
        failure = error as Error;
        entry.ignore = true;
      }
    },
  });
  if (failure) throw failure;
  return validateTarEntries(entries);
}

function validateTarEntries(entries: readonly TarEntry[]): TarEntry[] {
  const aliases = new Map<string, { path: string; direct: boolean }>();
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = validatePath(entry.path);
    const folded = foldedPath(entry.path);
    const prior = aliases.get(folded);
    if (prior?.direct || (prior !== undefined && prior.path !== entry.path)) {
      throw archiveError(`duplicate or NFC/case collision: ${prior.path} and ${entry.path}`);
    }
    aliases.set(folded, { path: entry.path, direct: true });

    if (entry.directory) {
      if (files.has(folded)) throw archiveError(`file-directory conflict at ${entry.path}`);
      directories.add(folded);
    } else {
      if (directories.has(folded)) throw archiveError(`file-directory conflict at ${entry.path}`);
      files.add(folded);
    }
    for (let length = 1; length < segments.length; length += 1) {
      const parentPath = segments.slice(0, length).join("/");
      const parent = foldedPath(parentPath);
      const parentAlias = aliases.get(parent);
      if (parentAlias !== undefined && parentAlias.path !== parentPath) {
        throw archiveError(`duplicate or NFC/case collision: ${parentAlias.path} and ${parentPath}`);
      }
      if (parentAlias === undefined) aliases.set(parent, { path: parentPath, direct: false });
      if (files.has(parent)) throw archiveError(`file-directory conflict at ${entry.path}`);
      directories.add(parent);
    }
  }
  return [...entries];
}

async function extractTarEntries(path: string, destination: string, gzip: boolean, planned: readonly TarEntry[]): Promise<void> {
  const plannedByPath = new Map(planned.map((entry) => [entry.path, entry]));
  let failure: Error | undefined;
  await extractTarArchive({
    file: path,
    cwd: destination,
    gzip,
    strict: true,
    preservePaths: false,
    keep: true,
    maxDepth: MAX_DEPTH,
    maxDecompressionRatio: MAX_COMPRESSION_RATIO,
    filter(_path, entry) {
      if (failure) return false;
      try {
        const actual = tarEntryInfo(entry as ReadEntry);
        const expected = plannedByPath.get(actual.path);
        if (!expected || expected.directory !== actual.directory || expected.size !== actual.size) {
          throw archiveError("TAR entry list changed during extraction");
        }
        return true;
      } catch (error) {
        failure = error as Error;
        return false;
      }
    }
  });
  if (failure) throw failure;
}

async function cleanupPrivateRoot(root: string): Promise<void> {
  if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), PRIVATE_PREFIX))) throw archiveError("refusing to clean an unknown temporary directory");
  await rm(root, { recursive: true, force: true });
}

export async function resolveLocalPluginZip(source: string): Promise<ResolvedLocalPluginZip> {
  return await resolveLocalPluginArchive(source);
}

export async function resolveLocalPluginArchive(source: string): Promise<ResolvedLocalPluginArchive> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw archiveError("source must be a regular file, not a link");
  if (sourceInfo.size > MAX_SOURCE_BYTES) throw archiveError("source archive exceeds 100 MiB");
  const kind = localArchiveKind(source);
  const privateRoot = await mkdtemp(join(tmpdir(), PRIVATE_PREFIX));
  try {
    const copied = await copyAndHash(source, privateRoot);
    const extracted = join(privateRoot, "contents");
    await mkdir(extracted);
    let wrapper: string | undefined;
    if (kind === "zip") {
      const planned = validateEntries(await readCentralDirectory(copied.path));
      wrapper = candidateWrapper(planned);
      await extractEntries(copied.path, extracted, planned);
    } else {
      const gzip = kind === "tar.gz";
      const planned = await readTarEntries(copied.path, gzip);
      wrapper = candidateWrapper(planned);
      await extractTarEntries(copied.path, extracted, gzip, planned);
    }
    return {
      archiveDigest: copied.digest,
      candidateRoot: wrapper === undefined ? extracted : join(extracted, wrapper),
      cleanup: () => cleanupPrivateRoot(privateRoot),
    };
  } catch (error) {
    await cleanupPrivateRoot(privateRoot);
    throw error;
  }
}
