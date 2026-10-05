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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_NOTE_CONTENT_LENGTH } from "@vykor/protocol";

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

export function readNoteFile(
  path: string,
): { content: string; modifiedAt: number; createdAt: number } | undefined {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`便签不是普通文件：${path}`);
  if (before.size > MAX_NOTE_CONTENT_LENGTH * 4)
    throw new Error(`便签文件过大：${path}`);
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
    if (content.length > MAX_NOTE_CONTENT_LENGTH)
      throw new Error(`便签文件过大：${path}`);
    return {
      content,
      modifiedAt: actual.mtimeMs,
      createdAt: actual.birthtimeMs || actual.mtimeMs,
    };
  } finally {
    closeSync(handle);
  }
}

export function replaceNoteFile(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, "wx");
    writeFileSync(handle, content, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
  } finally {
    if (handle !== undefined) closeSync(handle);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
