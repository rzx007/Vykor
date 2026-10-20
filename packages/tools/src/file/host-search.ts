import { execFile, spawn } from "node:child_process";
import picomatch from "picomatch";
import type { EnvironmentProcess } from "@vykor/environment";
import type { GrepOptions } from "./operations.js";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function globToRegex(pattern: string): RegExp {
  return picomatch.makeRe(pattern, { dot: true, posix: true });
}

export const MAX_LINE_BYTES = 64 * 1024;
export const SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", ".git", "dist", "build", ".next", ".turbo", "__pycache__",
]);

export function matchesGlob(path: string, pattern: string): boolean {
  return picomatch.isMatch(path, pattern, { dot: true, posix: true, basename: !pattern.includes("/") });
}

export function grepArgs(pattern: string, options: GrepOptions, target = "."): string[] {
  const args = ["--no-config", "--hidden", "--no-require-git", "--with-filename", "--no-heading", "--line-number", "--color", "never"];
  if (!options.caseSensitive) args.push("-i");
  // Positive --glob rules override .gitignore. Filter include in the collector instead.
  for (const directory of SKIP_DIRS) args.push("--glob", `!**/${directory}/**`);
  args.push("--", pattern, target);
  return args;
}

export function filterGlobOutput(stdout: string, pattern: string, limit: number): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeRgPath(line.trim()))
    .filter((line) => line && matchesGlob(line.replace(/\\/g, "/"), pattern))
    .slice(0, limit);
}

export function filterGrepOutput(stdout: string, limit: number): string[] {
  const matches: string[] = [];
  if (limit <= 0) return matches;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
    matches.push(line);
    if (matches.length >= limit) break;
  }
  return matches;
}

function normalizeRgPath(path: string): string {
  return path.replace(/^\.[\\/]/, "");
}

export function runHostProcess(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? typeof error.code === "number" ? error.code : -1 : 0,
      stdout, stderr,
    }));
  });
}

export function startHostSearch(command: string, args: string[], cwd: string, signal?: AbortSignal): EnvironmentProcess {
  const child = spawn(command, args, { cwd, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<{ exitCode: number | null }>((resolve, reject) => {
    child.once("error", (error) => {
      // AbortError arrives before close; wait until Windows releases the child's cwd and pipes.
      if (error.name !== "AbortError" || !child.pid) reject(error);
    });
    child.once("close", (exitCode) => resolve({ exitCode }));
  });
  // A spawn error can precede attachment by an async consumer.
  void completion.catch(() => {});
  return {
    write() {}, end() {},
    onOutput(listener) { child.stdout.on("data", listener); return () => { child.stdout.off("data", listener); }; },
    onErrorOutput(listener) { child.stderr.on("data", listener); return () => { child.stderr.off("data", listener); }; },
    wait: () => completion,
    async signal() { child.kill(); },
  };
}
