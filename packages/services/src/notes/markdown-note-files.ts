import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_NOTE_CONTENT_LENGTH } from "@vykor/domain-contracts/notes";

export function ensureNoteDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("便签存储目录不是普通目录。");
}

export function noteFilePath(directory: string, id: string): string {
  if (
    !/^[\p{L}\p{N}_ -]{1,120}$/u.test(id) ||
    /^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(id)
  )
    throw new Error("Invalid note file ID");
  return join(directory, `${id}.md`);
}

/** Check Markdown identities without reading bodies or updating their index. */
export function scanNoteIds(directory: string): string[] {
  ensureNoteDirectory(directory);
  const ids: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    const path = noteFilePath(directory, id);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`便签不是普通文件：${path}`);
    ids.push(id);
  }
  return ids;
}

export function readNoteFile(
  path: string,
): { content: string; modifiedAt: number; createdAt: number } | undefined {
  const file = readUtf8File(path, MAX_NOTE_CONTENT_LENGTH * 4);
  if (file && file.content.length > MAX_NOTE_CONTENT_LENGTH)
    throw new Error(`便签文件过大：${path}`);
  return file;
}

export function readUtf8File(
  path: string,
  maxBytes = 4_000_000,
):
  | {
      content: string;
      modifiedAt: number;
      createdAt: number;
      identity: string;
      fileKey: string;
    }
  | undefined {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`便签不是普通文件：${path}`);
  if (before.size > maxBytes) throw new Error(`便签文件过大：${path}`);
  const handle = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const actual = fstatSync(handle);
    if (
      !actual.isFile() ||
      actual.ino !== before.ino ||
      actual.dev !== before.dev
    )
      throw new Error("便签文件在读取时发生变化，请重试。");
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(readFileSync(handle));
    } catch {
      throw new Error(`便签文件不是 UTF-8 文本：${path}`);
    }
    return {
      content,
      modifiedAt: actual.mtimeMs,
      createdAt: actual.birthtimeMs || actual.mtimeMs,
      identity: `${actual.dev}:${actual.ino}:${actual.size}:${actual.mtimeMs}:${actual.ctimeMs}`,
      fileKey: `${actual.dev}:${actual.ino}`,
    };
  } finally {
    closeSync(handle);
  }
}

export function replaceNoteFile(path: string, content: string): void {
  replaceUtf8File(path, content);
}

export function replaceUtf8File(path: string, content: string): string {
  // Reject existing links before replacement, including dangling links.
  try {
    const target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink())
      throw new Error(`不是普通文件：${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, "wx");
    writeFileSync(handle, content, "utf8");
    fsyncSync(handle);
    const written = fstatSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
    return `${written.dev}:${written.ino}`;
  } finally {
    if (handle !== undefined) closeSync(handle);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
