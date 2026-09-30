import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import type { Settings, ToolContext } from "@vykor/core";
import type {
  EnvironmentFileSystem,
  ExecutionEnvironmentHandle,
} from "@vykor/environment";
import {
  MAX_LINE_BYTES,
  filterGlobOutput,
  filterGrepOutput,
  findRipgrep,
  globToRegex,
  grepArgs,
  runHostProcess,
} from "./host-search.js";

export { globToRegex } from "./host-search.js";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
}
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
}

export interface GrepOptions {
  include?: string;
  caseSensitive: boolean;
  limit: number;
}

/**
 * 明确表示“目标不存在”的结构化错误。
 * 只有 Host 的 ENOENT 与 WSL 固定脚本的不存在分支会映射到这里；
 * 权限、目录误用和其它 I/O 错误必须保持原错误类型，绝不能伪装成不存在。
 */
export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Path not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export interface FileOperations extends EnvironmentFileSystem {
  stat(path: string): Promise<FileStat>;
  listDir(path: string): Promise<FileEntry[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  glob(basePath: string, pattern: string, limit: number): Promise<string[]>;
  grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[]>;
}

export function fileOperationsFor(context: ToolContext): FileOperations {
  if (context.environment) return context.environment.files;
  return new HostFileOperations();
}

export class HostFileOperations implements FileOperations {
  async stat(path: string): Promise<FileStat> {
    try {
      const [item, linkInfo] = await Promise.all([stat(path), lstat(path)]);
      return { isFile: item.isFile(), isDirectory: item.isDirectory(), isSymbolicLink: linkInfo.isSymbolicLink() };
    } catch (error) {
      if (isEnoent(error)) throw new FileNotFoundError(path);
      throw error;
    }
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  async readText(path: string): Promise<string> {
    return await readFile(path, "utf-8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isEnoent(error)) throw new FileNotFoundError(path);
      throw error;
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async createTextExclusive(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.vykor-write-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    let existingMode: number | undefined;
    try {
      existingMode = (await stat(path)).mode & 0o7777;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const temporary = join(dirname(path), `.vykor-write-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(content, "utf8");
        if (existingMode !== undefined) await handle.chmod(existingMode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async removeFile(path: string): Promise<void> {
    const item = await lstat(path);
    if (!item.isFile()) throw new Error(`Refusing to remove non-file path: ${path}`);
    await unlink(path);
  }

  async glob(basePath: string, pattern: string, limit: number): Promise<string[]> {
    const rgPath = findRipgrep();
    if (!rgPath) return await walkGlob(basePath, pattern, limit, this);

    const args = ["--files"];
    const gitignore = join(basePath, ".gitignore");
    if (existsSync(join(basePath, ".git")) || existsSync(gitignore)) args.push("--hidden");
    if (existsSync(gitignore)) args.push("--ignore-file", gitignore);
    for (const directory of SKIP_DIRS) args.push("--glob", `!${directory}/**`);
    args.push(".");

    const result = await runHostProcess(rgPath, args, { cwd: basePath });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return await walkGlob(basePath, pattern, limit, this);
    }
    return filterGlobOutput(result.stdout, pattern, limit);
  }

  async grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[]> {
    const rgPath = findRipgrep();
    if (!rgPath) {
      return await fallbackGrep(basePath, pattern, options.include, options.caseSensitive, options.limit, this);
    }
    const args = grepArgs(basePath, pattern, options);
    const result = await runHostProcess(rgPath, args, { cwd: basePath });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return await fallbackGrep(basePath, pattern, options.include, options.caseSensitive, options.limit, this);
    }
    return filterGrepOutput(result.stdout, options.limit);
  }
}

// 固定 shell 脚本：路径只作为位置参数传入，绝不拼进脚本文本。
const WSL_MISSING_PARENT_SCRIPT = `ancestor=$(dirname -- "$1")
while [ ! -e "$ancestor" ]; do
  parent=$(dirname -- "$ancestor")
  if [ "$parent" = "$ancestor" ]; then exit 13; fi
  ancestor=$parent
done
if [ -d "$ancestor" ] && [ -x "$ancestor" ]; then exit "$missing_exit"; fi
exit 13`;

const WSL_READ_SCRIPT = `if [ ! -e "$1" ]; then
  missing_exit=3
  ${WSL_MISSING_PARENT_SCRIPT}
fi
/bin/cat -- "$1"`;

const WSL_STAT_SCRIPT = `if [ -L "$1" ]; then
  if [ -f "$1" ]; then printf symlink-file
  elif [ -d "$1" ]; then printf symlink-directory
  else printf symlink
  fi
elif [ -f "$1" ]; then printf file
elif [ -d "$1" ]; then printf directory
elif [ -e "$1" ]; then printf other
else
  missing_exit=2
  ${WSL_MISSING_PARENT_SCRIPT}
fi`;

const WSL_ATOMIC_WRITE_SCRIPT = `set -eu
target=$1
parent=$(dirname -- "$target")
mkdir -p -- "$parent"
tmp=$(mktemp -- "$parent/.vykor-write.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
if [ -e "$target" ]; then chmod --reference="$target" -- "$tmp"; fi
mv -T -f -- "$tmp" "$target"`;

const WSL_EXCLUSIVE_CREATE_SCRIPT = `set -eu
target=$1
parent=$(dirname -- "$target")
mkdir -p -- "$parent"
tmp=$(mktemp -- "$parent/.vykor-write.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
ln -- "$tmp" "$target"`;

const WSL_REMOVE_SCRIPT = `set -eu
if [ -L "$1" ] || [ ! -f "$1" ]; then echo "Refusing to remove non-file path: $1" >&2; exit 4; fi
rm -- "$1"`;

export class WslFileOperations implements FileOperations {
  constructor(private readonly environment: ExecutionEnvironmentHandle) {}

  async stat(path: string): Promise<FileStat> {
    const result = await this.run([
      "/bin/sh", "-c", WSL_STAT_SCRIPT, "vk-stat", path,
    ]);
    if (result.exitCode !== 0) {
      if (result.exitCode === 2) throw new FileNotFoundError(path);
      throw new Error(result.output || `Cannot stat path: ${path}`);
    }
    return {
      isFile: result.output === "file" || result.output === "symlink-file",
      isDirectory: result.output === "directory" || result.output === "symlink-directory",
      isSymbolicLink: result.output.startsWith("symlink"),
    };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const result = await this.run([
      "/usr/bin/find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\t%y\\0",
    ]);
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot list directory: ${path}`);
    return result.output.split("\0").filter(Boolean).map((entry) => {
      const [name, type] = entry.split("\t");
      return { name: name ?? "", isDirectory: type === "d" };
    });
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const result = await this.run(["/bin/sh", "-c", WSL_READ_SCRIPT, "vk-read", path], undefined, true);
    if (result.exitCode !== 0) {
      if (result.exitCode === 3) throw new FileNotFoundError(path);
      throw new Error(result.output || `Cannot read file: ${path}`);
    }
    return result.bytes;
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content));
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    const result = await this.run([
      "/bin/sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "vk-write", path,
    ], content, true);
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot write file: ${path}`);
  }

  async createTextExclusive(path: string, content: string): Promise<void> {
    const result = await this.run(
      ["/bin/sh", "-c", WSL_EXCLUSIVE_CREATE_SCRIPT, "vk-exclusive", path],
      new TextEncoder().encode(content),
      true,
    );
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot exclusively create file: ${path}`);
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    const result = await this.run(
      ["/bin/sh", "-c", WSL_ATOMIC_WRITE_SCRIPT, "vk-atomic", path],
      new TextEncoder().encode(content),
      true,
    );
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot write file: ${path}`);
  }

  async removeFile(path: string): Promise<void> {
    const result = await this.run(["/bin/sh", "-c", WSL_REMOVE_SCRIPT, "vk-remove", path], undefined, true);
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot remove file: ${path}`);
  }

  async glob(basePath: string, pattern: string, limit: number): Promise<string[]> {
    const files = await this.collectFiles(basePath, limit * 10);
    const matches = globToRegex(pattern);
    return files.filter((path) => matches.test(path)).slice(0, limit);
  }

  async grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[]> {
    const files = await this.collectFiles(basePath, options.limit * 20);
    const include = options.include ? globToRegex(options.include) : undefined;
    const expression = new RegExp(pattern, options.caseSensitive ? "" : "i");
    const results: string[] = [];
    for (const file of files) {
      if (include && !include.test(file)) continue;
      const content = await this.readText(posix.join(basePath, file)).catch(() => "");
      if (content.includes("\0")) continue;
      for (const [index, line] of content.split("\n").entries()) {
        if (!expression.test(line)) continue;
        results.push(`${file}:${index + 1}:${line}`);
        if (results.length >= options.limit) return results;
      }
    }
    return results;
  }

  private async collectFiles(basePath: string, limit: number): Promise<string[]> {
    const result = await this.run([
      "/usr/bin/find", basePath, "-type", "f", "-printf", "%P\\0",
    ]);
    if (result.exitCode !== 0) return [];
    return result.output.split("\0").filter((path) => {
      if (!path) return false;
      return !path.split("/").some((part) => part.startsWith(".") || SKIP_DIRS.has(part));
    }).slice(0, limit);
  }

  private async run(
    argv: string[],
    stdin?: Uint8Array,
    binary = false,
  ): Promise<{ exitCode: number; output: string; bytes: Uint8Array }> {
    const process = await this.environment.process.execProcess(argv, {
      cwd: this.environment.workspace.executionRoot,
    });
    const chunks: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    const stop = process.onOutput((chunk) => chunks.push(chunk));
    const stopErrors = process.onErrorOutput?.((chunk) => errors.push(chunk));
    if (stdin) process.write(stdin);
    process.end();
    try {
      const result = await process.wait();
      const bytes = concatBytes(chunks);
      const error = new TextDecoder("utf-8").decode(concatBytes(errors));
      return {
        exitCode: result.exitCode ?? 1,
        output: binary ? error : new TextDecoder().decode(bytes) || error,
        bytes,
      };
    } finally {
      stop();
      stopErrors?.();
    }
  }
}

export function createEnvironmentFileSystem(
  environment: ExecutionEnvironmentHandle,
  options: {
    settings?: Settings;
    sessionId?: string;
    signal?: AbortSignal;
  } = {},
): EnvironmentFileSystem {
  if (environment.info.kind === "wsl") return new WslFileOperations(environment);
  return new HostFileOperations();
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function walkGlob(
  dir: string,
  pattern: string,
  limit: number,
  operations: FileOperations = new HostFileOperations(),
): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  const st = await operations.stat(dir).catch(() => null);
  if (!st || !st.isDirectory) return results;

  async function walk(current: string): Promise<void> {
    if (results.length >= limit) return;
    let entries: FileEntry[];
    try {
      entries = await operations.listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
      } else {
        const rel = relative(dir, fullPath);
        const normalized = rel.split(/[\\/]/).join("/");
        if (regex.test(normalized)) results.push(rel);
      }
    }
  }

  await walk(dir);
  return results;
}

export async function fallbackGrep(
  basePath: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean,
  limit: number,
  operations: FileOperations = new HostFileOperations(),
): Promise<string[]> {
  const flags = caseSensitive ? "" : "i";
  const regex = new RegExp(pattern, flags);
  const includeRegex = include ? globToRegex(include) : null;
  const results: string[] = [];

  const matchLines = (content: string, displayPath: string): boolean => {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
      if (regex.test(line)) {
        results.push(`${displayPath}:${i + 1}:${line}`);
        if (results.length >= limit) return true;
      }
    }
    return false;
  };

  async function walk(dir: string): Promise<void> {
    const entries = await operations.listDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
        if (results.length >= limit) return;
      } else {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const content = await operations.readText(fullPath);
          if (content.includes("\0")) continue;
          const rel = relative(basePath, fullPath);
          if (matchLines(content, rel)) return;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  const st = await operations.stat(basePath);
  if (st.isFile) {
    const content = await operations.readText(basePath);
    matchLines(content, basePath);
  } else {
    await walk(basePath);
  }

  return results;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
]);
