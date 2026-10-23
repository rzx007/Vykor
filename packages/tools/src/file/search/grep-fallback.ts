import { once } from "node:events";
import { Worker } from "node:worker_threads";
import * as nativePath from "node:path";
import ignore, { type Ignore } from "ignore";
import type { EnvironmentFileSystem, EnvironmentGrepOptions, EnvironmentGrepResult } from "@vykor/environment";
import { GrepCollector, GrepSearchError, checkGrepOptions } from "./grep-search.js";
import { matchesGlob, MAX_LINE_BYTES, SKIP_DIRS } from "./host-search.js";

export const FALLBACK_FILE_BYTES = 4 * 1024 * 1024;
type SearchFiles = Pick<EnvironmentFileSystem, "stat" | "listDir" | "readText">;
interface Scope { root: string; rules: Ignore; priority: number }

// Keep potentially expensive JavaScript regex execution off the main thread.
const MATCH_WORKER = `const { parentPort, workerData } = require('node:worker_threads');
const expression = new RegExp(workerData.pattern, workerData.caseSensitive ? '' : 'i');
parentPort.on('message', lines => {
  const matches = [];
  for (let i = 0; i < lines.length; i++) if (expression.test(lines[i])) matches.push(i);
  parentPort.postMessage(matches);
});`;

export async function searchFallback(
  basePath: string,
  pattern: string,
  options: EnvironmentGrepOptions,
  files: SearchFiles,
  readSearchText: (path: string) => Promise<string>,
  paths: typeof nativePath | typeof nativePath.posix = nativePath,
): Promise<EnvironmentGrepResult> {
  checkGrepOptions(pattern, options);
  if (!options.limit) return { matches: [], truncated: false };
  try { new RegExp(pattern, options.caseSensitive ? "" : "i"); }
  catch { throw new GrepSearchError("invalid_input", "Invalid regular expression."); }
  const collector = new GrepCollector(options);
  const worker = new Worker(MATCH_WORKER, { eval: true, execArgv: [], workerData: { pattern, caseSensitive: options.caseSensitive } });
  let workerError: Error | undefined;
  worker.on("error", (error) => { workerError = error; });
  let interrupted: GrepSearchError | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const fail = (kind: "interrupted" | "timeout") => {
    interrupted = new GrepSearchError(kind, kind === "timeout" ? "Search timed out." : "Search interrupted.");
    rejectDeadline(interrupted);
  };
  const abort = () => fail("interrupted");
  const timer = setTimeout(() => fail("timeout"), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const check = () => { if (interrupted) throw interrupted; if (workerError) throw workerError; };

  async function rulesIn(root: string): Promise<Scope[]> {
    const scopes: Scope[] = [];
    for (const name of [".gitignore", ".ignore"]) {
      check();
      const content = await files.readText(paths.join(root, name)).catch((error: unknown) => {
        if (isMissing(error)) return "";
        throw error;
      });
      if (content) scopes.push({ root, rules: ignore({ ignorecase: false }).add(content), priority: name === ".ignore" ? 2 : 1 });
    }
    return scopes;
  }

  async function searchFile(file: string, display: string): Promise<boolean> {
    check();
    if (options.include && !matchesGlob(display.replaceAll("\\", "/"), options.include)) return true;
    let content = await readSearchText(file);
    check();
    if (content.includes("\0")) return true;
    if (Buffer.byteLength(content) > FALLBACK_FILE_BYTES) {
      collector.result.truncated = true;
      content = content.slice(0, content.lastIndexOf("\n"));
    }
    const lines = content.split(/\r?\n/);
    if (!content || content.endsWith("\n")) lines.pop();
    for (let offset = 0; offset < lines.length; offset += 128) {
      check();
      const batch = lines.slice(offset, offset + 128);
      for (let i = 0; i < batch.length; i++) {
        if (Buffer.byteLength(batch[i]!) > MAX_LINE_BYTES) {
          batch[i] = "";
          collector.result.truncated = true;
        }
      }
      const response = once(worker, "message");
      worker.postMessage(batch);
      const [indices] = await response as [number[]];
      check();
      for (const index of indices) {
        // Empty replacement lines must not turn a skipped long line into a match.
        if (Buffer.byteLength(lines[offset + index]!) > MAX_LINE_BYTES) continue;
        if (!collector.add(`${display}:${offset + index + 1}:${lines[offset + index]}`)) return false;
      }
    }
    return true;
  }

  async function walk(directory: string, inherited: Scope[]): Promise<boolean> {
    check();
    // .ignore beats .gitignore even when the latter is in a deeper directory.
    const scopes = [...inherited, ...await rulesIn(directory)].sort((a, b) => a.priority - b.priority);
    for (const entry of await files.listDir(directory)) {
      check();
      if (SKIP_DIRS.has(entry.name)) continue;
      const file = paths.join(directory, entry.name);
      let ignored = false;
      for (const scope of scopes) {
        const relative = paths.relative(scope.root, file).replaceAll("\\", "/") + (entry.isDirectory ? "/" : "");
        const decision = scope.rules.test(relative);
        if (decision.ignored) ignored = true;
        else if (decision.unignored) ignored = false;
      }
      if (ignored) continue;
      if (entry.isDirectory) {
        if (!await walk(file, scopes)) return false;
      } else {
        // Match rg's default of not following filesystem links while walking.
        const stat = await files.stat(file);
        if (!stat.isFile || stat.isSymbolicLink) continue;
        if (!await searchFile(file, paths.relative(basePath, file).replaceAll("\\", "/"))) return false;
      }
    }
    return true;
  }

  async function search(): Promise<EnvironmentGrepResult> {
    const stat = await files.stat(basePath);
    check();
    if (stat.isFile) {
      await searchFile(basePath, paths.basename(basePath));
    } else {
      // Ancestor rules apply when the caller narrows path to a repository subdirectory.
      const ancestors: string[] = [];
      let ancestor = basePath;
      let gitDirectory: string | undefined;
      while (true) {
        check();
        const git = await files.stat(paths.join(ancestor, ".git")).catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
        if (git) {
          gitDirectory = paths.join(ancestor, ".git");
          if (git.isFile) {
            const pointer = await files.readText(gitDirectory);
            const target = /^gitdir:\s*(.+)/.exec(pointer)?.[1]?.trim();
            gitDirectory = target ? paths.resolve(ancestor, target) : undefined;
          }
          break;
        }
        const parent = paths.dirname(ancestor);
        if (ancestor === parent) break;
        ancestor = parent;
        ancestors.unshift(ancestor);
      }
      const inherited: Scope[] = [];
      if (gitDirectory) {
        const exclude = await files.readText(paths.join(gitDirectory, "info", "exclude")).catch((error: unknown) => {
          if (isMissing(error)) return "";
          throw error;
        });
        if (exclude) inherited.push({ root: ancestor, rules: ignore({ ignorecase: false }).add(exclude), priority: 0 });
      }
      for (const directory of ancestors) inherited.push(...await rulesIn(directory));
      await walk(basePath, inherited);
    }
    return collector.result;
  }
  try { return await Promise.race([search(), deadline]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    // Stop regex evaluation even if it is stuck in a pathological pattern.
    interrupted ??= new GrepSearchError("interrupted", "Search finished.");
    await worker.terminate();
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
