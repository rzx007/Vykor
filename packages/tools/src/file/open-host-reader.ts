import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readlink, stat, type FileHandle } from "node:fs/promises";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentFileStat, EnvironmentReadBytesOptions } from "@vykor/environment";

const execFileAsync = promisify(execFile);

export interface HostFileReader {
  canonicalPath: string;
  stat: EnvironmentFileStat;
  readBytes(options: EnvironmentReadBytesOptions & { maxBytes: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The caller authorizes canonicalPath before reading from this same open object. */
export async function openHostFileReader(path: string, signal?: AbortSignal, verifiedNtfsVolumes?: Set<string>): Promise<HostFileReader> {
  signal?.throwIfAborted();
  if (process.platform !== "linux" && process.platform !== "win32") throw unsupported();
  if (process.platform === "win32" && !/^[a-zA-Z]:\\[^:]*$/.test(win32.resolve(path))) throw unsupported();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    signal?.throwIfAborted();
    const item = await handle.stat({ bigint: true });
    if (!item.isFile()) throw Object.assign(new Error("Expected a regular file"), { code: "EFTYPE" });
    const canonicalPath = process.platform === "linux"
      ? await linuxHandlePath(handle)
      : await windowsHandlePath(path, item, signal, verifiedNtfsVolumes);
    signal?.throwIfAborted();
    let started = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    return {
      canonicalPath,
      stat: { isFile: true, isDirectory: false, sizeBytes: Number(item.size), modifiedAt: Number(item.mtimeNs) / 1_000_000 },
      async readBytes(options) {
        if (closed) throw Object.assign(new Error("File reader is closed"), { code: "EBADF" });
        signal?.throwIfAborted(); options.signal?.throwIfAborted();
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
        if (started) throw Object.assign(new Error("File reader has already been consumed"), { code: "EALREADY" });
        started = true;
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(Math.min(options.maxBytes, 64 * 1024));
        let position = 0;
        while (position < options.maxBytes) {
          signal?.throwIfAborted(); options.signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, options.maxBytes - position), position);
          signal?.throwIfAborted(); options.signal?.throwIfAborted();
          if (bytesRead === 0) break;
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
          position += bytesRead;
        }
        return Buffer.concat(chunks);
      },
      close() {
        closed = true;
        return closing ??= handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function linuxHandlePath(handle: FileHandle): Promise<string> {
  let path: string;
  try { path = await readlink(`/proc/self/fd/${handle.fd}`); }
  catch { throw unsupported(); }
  if (!path.startsWith("/") || path.endsWith(" (deleted)")) throw unsupported();
  return path;
}

type FileIdentity = { dev: bigint; ino: bigint; nlink: bigint };

async function windowsHandlePath(path: string, item: FileIdentity, signal?: AbortSignal, verifiedNtfsVolumes?: Set<string>): Promise<string> {
  const drive = win32.parse(win32.resolve(path)).root;
  if (!/^[a-zA-Z]:\\$/.test(drive) || item.ino === 0n || item.nlink !== 1n) throw unsupported();
  const volume = await stat(drive, { bigint: true });
  if (volume.dev !== item.dev) throw unsupported();
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw unsupported();
  try {
    const volumeKey = `${drive.toUpperCase()}:${item.dev}`;
    if (!verifiedNtfsVolumes?.has(volumeKey)) {
      const format = await execFileAsync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; [IO.DriveInfo]::new('${drive}').DriveFormat`,
      ], { windowsHide: true, cwd: join(systemRoot, "System32"), signal, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      if (format.stdout.trim() !== "NTFS") throw unsupported();
      signal?.throwIfAborted();
      // Owned by one environment; this caches only the volume's filesystem kind.
      verifiedNtfsVolumes?.add(volumeKey);
    }
    // Only a validated drive root and a hexadecimal ID enter this fixed command.
    // The code page is needed because fsutil otherwise loses some Unicode names.
    const query = await execFileAsync(join(systemRoot, "System32", "cmd.exe"), [
      "/d", "/c", `chcp 65001>nul && fsutil.exe file queryFileNameById ${drive} 0x${item.ino.toString(16)}`,
    ], { windowsHide: true, cwd: join(systemRoot, "System32"), signal, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    const match = query.stdout.match(/\\\\\?\\([a-zA-Z]:\\[^\r\n]*)\r?\n?$/u);
    if (!match?.[1]) throw unsupported();
    const canonicalPath = match[1];
    const current = await stat(canonicalPath, { bigint: true });
    if (current.dev !== item.dev || current.ino !== item.ino || current.nlink !== 1n) throw unsupported();
    return canonicalPath;
  } catch (error) {
    signal?.throwIfAborted();
    throw unsupported();
  }
}

function unsupported(): Error & { code: string } {
  return Object.assign(new Error("The filesystem cannot verify the opened file path"), { code: "ENOTSUP" });
}
