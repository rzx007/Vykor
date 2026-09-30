import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { GrepOptions } from "./operations.js";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

export const MAX_LINE_BYTES = 64 * 1024;

export function findRipgrep(): string | null {
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

export function grepArgs(basePath: string, pattern: string, options: GrepOptions): string[] {
  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (existsSync(join(basePath, ".git")) || existsSync(join(basePath, ".gitignore"))) args.push("--hidden");
  if (!options.caseSensitive) args.push("-i");
  if (options.include) args.push("--glob", options.include);
  args.push("--", pattern, ".");
  return args;
}

export function filterGlobOutput(stdout: string, pattern: string, limit: number): string[] {
  const matchesPattern = globToRegex(pattern);
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeRgPath(line.trim()))
    .filter((line) => line && matchesPattern.test(line.replace(/\\/g, "/")))
    .slice(0, limit);
}

export function filterGrepOutput(stdout: string, limit: number): string[] {
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

export function runHostProcess(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
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
