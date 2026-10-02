import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import {
  getTasksDir,
  type ShellOutputCapture,
  type ShellOutputLogHost,
  type ShellOutputLogPage,
  type ShellOutputLogSearchResult,
  type ShellOutputLogStatus,
} from "@vykor/core";
import { appendBoundedOutput, MAX_PERSISTED_EXECUTION_OUTPUT_BYTES } from "./bounded-output-file.js";

const MAX_LOGS = 64;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFERENCE = /^shell-output:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Metadata {
  sessionHash: string;
  createdAt: number;
  retainedBytes: number;
  discardedBytes: number;
  complete: boolean;
  finished: boolean;
}

// One host process can create multiple runtimes for the same managed directory.
const activeByDirectory = new Map<string, Set<string>>();
const activeKey = (directory: string) => process.platform === "win32" ? directory.toLowerCase() : directory;

function ownerHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function safeDirectory(directory: string): void {
  const root = parse(directory).root;
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed log directory is unsafe");
  }
}

function safeFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

function readMetadata(path: string): Metadata | undefined {
  if (!safeFile(path)) return undefined;
  try {
    if (statSync(path).size > 4096) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const item = value as Partial<Metadata>;
    if (typeof item.sessionHash !== "string" || !/^[0-9a-f]{64}$/.test(item.sessionHash) ||
        !Number.isSafeInteger(item.createdAt) || typeof item.complete !== "boolean" ||
        typeof item.finished !== "boolean" || !Number.isSafeInteger(item.retainedBytes) ||
        !Number.isSafeInteger(item.discardedBytes) || item.retainedBytes! < 0 || item.discardedBytes! < 0) return undefined;
    return item as Metadata;
  } catch { return undefined; }
}

function writeMetadata(path: string, metadata: Metadata, first = false): void {
  if (!first && !safeFile(path)) throw new Error("Managed log metadata is unsafe");
  writeFileSync(path, JSON.stringify(metadata), first ? { flag: "wx" } : undefined);
}

function managedFiles(directory: string, id: string) {
  return { log: join(directory, `${id}.log`), meta: join(directory, `${id}.json`) };
}

function removeManaged(directory: string, id: string): void {
  const { log, meta } = managedFiles(directory, id);
  if (safeFile(log)) rmSync(log);
  if (safeFile(meta)) rmSync(meta);
}

function claimSlot(directory: string, active: Set<string>): boolean {
  safeDirectory(directory);
  const names = readdirSync(directory);
  const logs = names.filter((name) => name.endsWith(".log") && ID.test(name.slice(0, -4))).map((name) => name.slice(0, -4));
  const ended: Array<{ id: string; createdAt: number }> = [];
  for (const id of logs) {
    if (active.has(id)) continue;
    const { log, meta } = managedFiles(directory, id);
    if (!safeFile(log)) continue;
    const metadata = readMetadata(meta);
    const createdAt = metadata?.createdAt ?? lstatSync(log).mtimeMs;
    if (Date.now() - createdAt > TTL_MS) {
      removeManaged(directory, id);
    } else {
      ended.push({ id, createdAt });
    }
  }
  let count = readdirSync(directory).filter((name) => name.endsWith(".log") && ID.test(name.slice(0, -4))).length;
  ended.sort((a, b) => a.createdAt - b.createdAt);
  while (count >= MAX_LOGS && ended.length > 0) {
    removeManaged(directory, ended.shift()!.id);
    count--;
  }
  return count < MAX_LOGS;
}

function availableLog(directory: string, sessionId: string | undefined, reference: string): { path: string; size: number; metadata: Metadata } | undefined {
  const id = REFERENCE.exec(reference)?.[1];
  if (!sessionId || !id) return undefined;
  try {
    safeDirectory(directory);
    const { log, meta } = managedFiles(directory, id);
    const metadata = readMetadata(meta);
    if (!metadata || metadata.sessionHash !== ownerHash(sessionId) ||
        (Date.now() - metadata.createdAt > TTL_MS && !activeByDirectory.get(activeKey(directory))?.has(id)) || !safeFile(log)) return undefined;
    const size = statSync(log).size;
    if (!Number.isSafeInteger(size) || size > MAX_PERSISTED_EXECUTION_OUTPUT_BYTES ||
        (metadata.finished && size !== metadata.retainedBytes)) return undefined;
    return { path: log, size, metadata };
  } catch { return undefined; }
}

function captureFor(directory: string, active: Set<string>, sessionId: string | undefined, inlineChars: number): ShellOutputCapture {
  const threshold = Number.isSafeInteger(inlineChars) && inlineChars >= 0 ? inlineChars : 12_000;
  let pending = "";
  let id: string | undefined;
  let metadata: Metadata | undefined;
  let discardedBytes = 0;
  let retainedBytes = 0;
  let stopped = false;
  let reason: string | undefined;
  let final: ShellOutputLogStatus | undefined;

  function append(text: string): void {
    if (final || !text) return;
    if (!sessionId) { reason = "session unavailable"; return; }
    if (stopped) { discardedBytes += Buffer.byteLength(text); return; }
    if (!id && pending.length + text.length <= threshold) { pending += text; return; }
    try {
      // The managed directory may have been replaced after begin().
      safeDirectory(directory);
      if (!id) {
        if (!claimSlot(directory, active)) {
          stopped = true;
          reason = "log quota exhausted";
          discardedBytes += Buffer.byteLength(pending + text);
          pending = "";
          return;
        }
        id = randomUUID();
        const { log, meta } = managedFiles(directory, id);
        metadata = { sessionHash: ownerHash(sessionId), createdAt: Date.now(), retainedBytes: 0, discardedBytes: 0, complete: false, finished: false };
        writeFileSync(log, "", { flag: "wx" });
        writeMetadata(meta, metadata, true);
        active.add(id);
      }
      const { log, meta } = managedFiles(directory, id);
      if (!safeFile(log)) throw new Error("Managed log file is unsafe");
      const incoming = pending + text;
      pending = "";
      const result = appendBoundedOutput(log, incoming, MAX_PERSISTED_EXECUTION_OUTPUT_BYTES, "prefix");
      retainedBytes += result.retainedBytes;
      discardedBytes += result.discardedBytes;
      if (result.discardedBytes > 0) {
        stopped = true;
        metadata!.retainedBytes = retainedBytes;
        metadata!.discardedBytes = discardedBytes;
        writeMetadata(meta, metadata!);
      }
    } catch {
      stopped = true;
      reason = "log write failed";
      pending = "";
    }
  }

  function finish(complete: boolean): ShellOutputLogStatus {
    if (final) return final;
    if (id) {
      active.delete(id);
      const { log, meta } = managedFiles(directory, id);
      try {
        safeDirectory(directory);
        if (!safeFile(log)) throw new Error("Managed log file is unsafe");
        retainedBytes = statSync(log).size;
        metadata!.retainedBytes = retainedBytes;
        metadata!.discardedBytes = discardedBytes;
        metadata!.complete = complete && discardedBytes === 0 && !reason;
        metadata!.finished = true;
        writeMetadata(meta, metadata!);
      } catch { reason = "log write failed"; }
    }
    const reference = id && sessionId && availableLog(directory, sessionId, `shell-output://${id}`)
      ? `shell-output://${id}` : undefined;
    final = { reference, retainedBytes, discardedBytes, complete: !!reference && complete && discardedBytes === 0 && !reason,
      available: !!reference, ...(reason ? { reason } : {}) };
    return final;
  }
  return { append, finish };
}

async function readPage(directory: string, input: Parameters<ShellOutputLogHost["read"]>[0]): Promise<ShellOutputLogPage> {
  const found = availableLog(directory, input.sessionId, input.reference);
  if (!found) return { status: "unavailable" };
  const cursor = input.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > found.size) return { status: "invalid_cursor" };
  let fd: number | undefined;
  try {
    fd = openSync(found.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return { status: "unavailable" };
    if (cursor < found.size) {
      const first = Buffer.alloc(1);
      readSync(fd, first, 0, 1, cursor);
      if ((first[0]! & 0xc0) === 0x80) return { status: "invalid_cursor" };
    }
    const requested = Number.isSafeInteger(input.maxBytes) ? input.maxBytes! : 8192;
    const length = Math.min(found.size - cursor, Math.max(4, Math.min(8192, requested)));
    const bytes = Buffer.alloc(length);
    const received = readSync(fd, bytes, 0, length, cursor);
    let consumed = received;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let text = "";
    while (consumed > 0) {
      try { text = decoder.decode(bytes.subarray(0, consumed)); break; }
      catch { consumed--; }
    }
    if (received > 0 && consumed === 0) return { status: "unavailable" };
    const nextCursor = cursor + consumed;
    return { status: "ok", text, nextCursor, eof: nextCursor === found.size,
      retainedBytes: found.size, discardedBytes: found.metadata.discardedBytes,
      complete: found.metadata.complete && found.metadata.finished && found.metadata.discardedBytes === 0 };
  } catch { return { status: "unavailable" }; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } } }
}

async function searchLog(directory: string, input: Parameters<ShellOutputLogHost["search"]>[0]): Promise<ShellOutputLogSearchResult> {
  const unavailable: ShellOutputLogSearchResult = { status: "unavailable", matches: [], truncated: false };
  const found = availableLog(directory, input.sessionId, input.reference);
  if (!found) return unavailable;
  if (typeof input.pattern !== "string" || input.pattern.includes("\0")) {
    return { status: "invalid_pattern", matches: [], truncated: false };
  }
  if (input.signal?.aborted) return { status: "timeout", matches: [], truncated: true };
  return await new Promise((resolveResult) => {
    let output = Buffer.alloc(0);
    let error = "";
    let status: ShellOutputLogSearchResult["status"] | undefined;
    const args = ["--no-config", "--text", "--no-heading", "--color", "never", "--byte-offset", "--only-matching"];
    if (!input.caseSensitive) args.push("--ignore-case");
    args.push("-e", input.pattern, "--", found.path);
    let child: ReturnType<typeof spawn>;
    try { child = spawn("rg", args, { windowsHide: true }); }
    catch { resolveResult({ status: "search_unavailable", matches: [], truncated: false }); return; }
    const timer = setTimeout(() => { status = "timeout"; child.kill(); }, 5000);
    const abort = () => { status = "timeout"; child.kill(); };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (status) return;
      if (output.length + chunk.length > 32 * 1024) { status = "limit"; child.kill(); return; }
      output = Buffer.concat([output, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => { error += chunk.toString("utf8").slice(0, 2048 - error.length); });
    child.on("error", () => { status = "search_unavailable"; });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const matches: ShellOutputLogSearchResult["matches"] = [];
      const lines = output.toString("utf8").split(/\r?\n/);
      if (status && lines.at(-1)) lines.pop();
      for (const line of lines) {
        const match = /^(\d+):(.*)$/.exec(line);
        if (match) {
          if (matches.length === 200) { status = "limit"; break; }
          matches.push({ byteOffset: Number(match[1]), text: match[2]! });
        }
      }
      if (!status && code === 2) status = error.includes("regex parse error") ? "invalid_pattern" : "search_unavailable";
      resolveResult({ status: status ?? "ok", matches, truncated: !!status });
    });
  });
}

/** Managed foreground Shell logs. The directory is chosen by the host, never by a tool input. */
export function createShellOutputLogHost(options: { directory?: string } = {}): ShellOutputLogHost {
  const directory = resolve(options.directory ?? join(getTasksDir(), "shell-output"));
  const key = activeKey(directory);
  let active = activeByDirectory.get(key);
  if (!active) { active = new Set(); activeByDirectory.set(key, active); }
  return {
    begin: (sessionId, inlineChars) => captureFor(directory, active, sessionId, inlineChars),
    read: (input) => readPage(directory, input),
    search: (input) => searchLog(directory, input),
  };
}
