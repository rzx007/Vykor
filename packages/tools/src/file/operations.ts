import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import type { Settings, ToolContext } from "@vykor/core";
import type {
  EnvironmentFileSystem,
  ExecutionEnvironmentHandle,
} from "@vykor/environment";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
}
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface GrepOptions {
  include?: string;
  caseSensitive: boolean;
  limit: number;
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
    const item = await stat(path);
    return { isFile: item.isFile(), isDirectory: item.isDirectory() };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  async readText(path: string): Promise<string> {
    return await readFile(path, "utf-8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return await readFile(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
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

export class WslFileOperations implements FileOperations {
  constructor(private readonly environment: ExecutionEnvironmentHandle) {}

  async stat(path: string): Promise<FileStat> {
    const result = await this.run([
      "/bin/sh", "-c",
      'if [ -f "$1" ]; then printf file; elif [ -d "$1" ]; then printf directory; else exit 2; fi',
      "vk-stat", path,
    ]);
    if (result.exitCode !== 0) throw new Error(result.output || `Path not found: ${path}`);
    return { isFile: result.output === "file", isDirectory: result.output === "directory" };
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
    const result = await this.run(["/bin/cat", "--", path], undefined, true);
    if (result.exitCode !== 0) throw new Error(result.output || `Cannot read file: ${path}`);
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

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "{{GLOBSTARSLASH}}")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTARSLASH\}\}/g, "(?:.*/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`);
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

const MAX_LINE_BYTES = 64 * 1024;
const FILE_HELPER_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    if (input.op === "stat") {
      const st = fs.statSync(input.path);
      console.log(JSON.stringify({ isFile: st.isFile(), isDirectory: st.isDirectory() }));
    } else if (input.op === "listDir") {
      const entries = fs.readdirSync(input.path, { withFileTypes: true })
        .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      console.log(JSON.stringify(entries));
    } else if (input.op === "readText") {
      console.log(JSON.stringify({ content: fs.readFileSync(input.path, "utf8") }));
    } else if (input.op === "readBytes") {
      console.log(JSON.stringify({ content: fs.readFileSync(input.path).toString("base64") }));
    } else if (input.op === "writeText") {
      fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, input.content ?? "", "utf8");
      console.log(JSON.stringify({ ok: true }));
    } else if (input.op === "writeBytes") {
      fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, Buffer.from(input.content ?? "", "base64"));
      console.log(JSON.stringify({ ok: true }));
    } else {
      throw new Error("unknown file helper op: " + input.op);
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
});
`;

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function findRipgrep(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, ["rg"], {
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    const matches = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const first = process.platform === "win32"
      ? matches.find((line) => line.toLowerCase().endsWith(".exe")) ?? matches[0]
      : matches[0];
    return first || null;
  } catch {
    return null;
  }
}

function grepArgs(basePath: string, pattern: string, options: GrepOptions): string[] {
  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (existsSync(join(basePath, ".git")) || existsSync(join(basePath, ".gitignore"))) args.push("--hidden");
  if (!options.caseSensitive) args.push("-i");
  if (options.include) args.push("--glob", options.include);
  args.push("--", pattern, ".");
  return args;
}

function filterGlobOutput(stdout: string, pattern: string, limit: number): string[] {
  const matchesPattern = globToRegex(pattern);
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeRgPath(line.trim()))
    .filter((line) => line && matchesPattern.test(line.replace(/\\/g, "/")))
    .slice(0, limit);
}

function filterGrepOutput(stdout: string, limit: number): string[] {
  const matches: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
    matches.push(line.trim());
    if (matches.length >= limit) break;
  }
  return matches;
}

function normalizeRgPath(path: string): string {
  return path.replace(/^\.[\\/]/, "");
}

function runHostProcess(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = execFileSync;
    try {
      const stdout = child(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      resolve({ exitCode: 0, stdout, stderr: "" });
    } catch (error) {
      const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      resolve({
        exitCode: typeof err.status === "number" ? err.status : -1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      });
    }
  });
}
