import { spawn } from "node:child_process";
import { terminateProcessTree } from "@vykor/sandbox";

import type { AutoReviewReason } from "@vykor/protocol";

import type { AutoReviewChangeFile, AutoReviewChangeSet } from "./auto-review-policy.js";
import {
  assemblePatch,
  buildDigest,
  decodeTrimmed,
  isUnmergedStatus,
  mapStatus,
  parseIndex,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  sameDirtyMap,
  sortFiles,
  uniquePaths,
  type NumstatEntry,
  type RepoState,
} from "./git-change-parsing.js";

export { GIT_PATCH_LIMIT_BYTES } from "./git-change-parsing.js";

const GIT_INSPECTION_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{40,64}$/;
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

export interface GitRunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** 可注入的 Git 调用面，便于确定性测试与替换。所有命令一律使用参数数组。 */
export interface GitExecutor {
  /** Abort-aware hosts settle only after their owned subprocess has closed. */
  exec(args: string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult>;
}

export interface GitDirtyEntry {
  status: string;
  worktreeHash: string | "missing";
  indexHash: string | "missing";
  indexMode: string | "missing";
}

export interface GitRunBaseline {
  repositoryRoot: string;
  head: string;
  dirty: Record<string, GitDirtyEntry>;
}

export interface GitRunChangeSet extends AutoReviewChangeSet {
  baseHead: string;
  head: string;
  patch: string;
}

/** 无法安全归因时的显式结果，绝不回退去审查整个工作区。 */
export interface GitRunChangeUnavailable {
  attribution: "unavailable";
  reason: AutoReviewReason;
}

export interface GitRunChangeInspector {
  /** Injected hosts must honor cancellation and clean up before settling. */
  capture(cwd: string, signal?: AbortSignal): Promise<GitRunBaseline | GitRunChangeUnavailable>;
  compare(
    cwd: string,
    baseline: GitRunBaseline,
    signal?: AbortSignal,
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable>;
}

export function createExecFileGitExecutor(): GitExecutor {
  return {
    async exec(args, cwd, signal) {
      signal?.throwIfAborted();
      // Names originate in Git -z records, so []/wildcards/magic are literal filenames.
      const configArgs = ["--literal-pathspecs", "-c", "core.fsmonitor=false"];
      if (args[0] === "status" || args[0] === "diff") {
        // Git status/diff can invoke clean/process filters themselves. Read names only,
        // never configuration values, then disable those programs at this single boundary.
        const filters = await execGitCommand([...configArgs, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], cwd, signal);
        signal?.throwIfAborted();
        if (filters.code !== 0 && filters.code !== 1) return filters;
        const sections = new Set(filters.stdout.toString("utf8").split("\0").filter(Boolean).map((key) => key.slice(0, key.lastIndexOf("."))));
        for (const section of sections) configArgs.push("-c", `${section}.clean=`, "-c", `${section}.smudge=`, "-c", `${section}.process=`, "-c", `${section}.required=false`);
      }
      const commandArgs = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
        : args[0] === "hash-object" ? ["hash-object", "--no-filters", ...args.slice(1)] : args;
      const result = await execGitCommand([...configArgs, ...commandArgs], cwd, signal);
      signal?.throwIfAborted();
      return result;
    },
  };
}

function execGitCommand(args: string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    let closed = false;
    let exitCode = 1;
    let stopping: Promise<boolean> | undefined;
    let inspectionError: Error | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // spawn supports a POSIX process group; execFile does not. Limits and aborts
    // stay with this owner so no built-in stop can kill a launcher before its tree.
    const child = spawn("git", args, {
      cwd, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const finish = async () => {
      if (!closed) return;
      await stopping;
      clearTimeout(commandTimer);
      signal?.removeEventListener("abort", stop);
      if (inspectionError) { reject(inspectionError); return; }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), code: exitCode });
    };
    const stop = () => {
      if (closed) return;
      stopping ??= terminateProcessTree(child);
      void stopping.then(finish);
    };
    const commandTimer = setTimeout(() => { inspectionError = new Error("Git inspection timed out"); stop(); }, GIT_INSPECTION_TIMEOUT_MS);
    const collect = (chunk: Buffer, output: Buffer[], channel: "stdout" | "stderr") => {
      if (channel === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > GIT_MAX_BUFFER_BYTES || stderrBytes > GIT_MAX_BUFFER_BYTES) {
        inspectionError = new Error("Git inspection output exceeds buffer limit");
        stop();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        return;
      }
      output.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr, "stderr"));
    child.once("error", (error) => { inspectionError = error; });
    child.once("close", (code) => { exitCode = code ?? 1; closed = true; void finish(); });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export function createGitRunChangeInspector(
  executor: GitExecutor = createExecFileGitExecutor(),
): GitRunChangeInspector {
  return new DefaultGitRunChangeInspector(executor);
}

interface CollectedEntries {
  entries: Record<string, GitDirtyEntry>;
  hashes: Record<string, string | "missing">;
}

class DefaultGitRunChangeInspector implements GitRunChangeInspector {
  constructor(private readonly executor: GitExecutor) {}

  async capture(cwd: string, signal?: AbortSignal): Promise<GitRunBaseline | GitRunChangeUnavailable> {
    if (signal) return this.scoped(signal).capture(cwd);
    const first = await readRepoState(this.executor, cwd);
    if (first === "no-repo") return unavailable("not_git_repository");
    if (!first) return unavailable("git_inspection_failed");
    // Porcelain/index paths are repository-relative, even when the Run cwd is nested.
    cwd = first.root;

    const paths = first.entries.map((entry) => entry.path);
    const collected = await this.collect(first, cwd, paths);
    if (!collected) return unavailable("git_inspection_failed");
    const digestA = buildDigest(first, paths, collected.hashes);

    const second = await readRepoState(this.executor, cwd);
    if (second === "no-repo" || !second) return unavailable("git_inspection_failed");
    const collectedSecond = await this.collect(second, cwd, paths);
    if (!collectedSecond) return unavailable("git_inspection_failed");
    const digestB = buildDigest(second, paths, collectedSecond.hashes);
    if (digestA !== digestB) return unavailable("git_inspection_failed");

    return { repositoryRoot: first.root, head: first.head, dirty: collected.entries };
  }

  async compare(
    cwd: string,
    baseline: GitRunBaseline,
    signal?: AbortSignal,
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable> {
    if (signal) return this.scoped(signal).compare(cwd, baseline);
    const first = await readRepoState(this.executor, cwd);
    if (!first || first === "no-repo") return unavailable("git_inspection_failed");
    if (first.root !== baseline.repositoryRoot) return unavailable("git_inspection_failed");
    cwd = first.root;

    const currentPaths = first.entries.map((entry) => entry.path);
    const relevant = uniquePaths([...Object.keys(baseline.dirty), ...currentPaths]);
    const collected = await this.collect(first, cwd, relevant);
    if (!collected) return unavailable("git_inspection_failed");
    const digestA = buildDigest(first, relevant, collected.hashes);

    let result: GitRunChangeSet | GitRunChangeUnavailable | undefined;
    if (first.head === baseline.head) {
      for (const path of Object.keys(baseline.dirty)) {
        const current = collected.entries[path];
        const base = baseline.dirty[path]!;
        if (
          !current ||
          current.status !== base.status ||
          current.worktreeHash !== base.worktreeHash ||
          current.indexHash !== base.indexHash ||
          current.indexMode !== base.indexMode
        ) {
          return unavailable("preexisting_dirty_overlap");
        }
      }
      const newPaths = currentPaths.filter((path) => !Object.hasOwn(baseline.dirty, path));
      const contextPaths = first.entries
        .map((entry) => entry.oldPath)
        .filter((path): path is string => path !== undefined && !Object.hasOwn(baseline.dirty, path));
      result = await this.buildWorktreeChangeSet(cwd, first, newPaths, contextPaths);
    } else {
      const ancestor = await this.isAncestor(cwd, baseline.head, first.head);
      if (!ancestor) return unavailable("non_linear_head_change");
      const currentDirty: Record<string, GitDirtyEntry> = Object.create(null);
      for (const path of currentPaths) currentDirty[path] = collected.entries[path]!;
      if (!sameDirtyMap(currentDirty, baseline.dirty)) {
        return unavailable("post_commit_worktree_changed");
      }
      result = await this.buildCommitChangeSet(cwd, baseline.head, first.head);
    }
    if (result && isUnavailable(result)) return result;
    if (!result) return unavailable("git_inspection_failed");

    const second = await readRepoState(this.executor, cwd);
    if (!second || second === "no-repo") return unavailable("git_inspection_failed");
    const collectedSecond = await this.collect(second, cwd, relevant);
    if (!collectedSecond) return unavailable("git_inspection_failed");
    const digestB = buildDigest(second, relevant, collectedSecond.hashes);
    if (digestA !== digestB) return unavailable("git_inspection_failed");

    return result;
  }

  private scoped(signal: AbortSignal): DefaultGitRunChangeInspector {
    return new DefaultGitRunChangeInspector({ exec: async (args, cwd) => {
      signal.throwIfAborted();
      const result = await this.executor.exec(args, cwd, signal);
      signal.throwIfAborted();
      return result;
    } });
  }

  private async buildWorktreeChangeSet(
    cwd: string,
    state: RepoState,
    newPaths: string[],
    contextPaths: string[],
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable | undefined> {
    const pathspec = uniquePaths([...newPaths, ...contextPaths]);

    const nameStatus = await this.readNameStatus(cwd, ["HEAD", "--", ...pathspec]);
    if (!nameStatus) return undefined;
    if (hasSensitiveContentPath(newPaths, nameStatus)) return unavailable("sensitive_content_path");
    const numstat = await this.readNumstat(cwd, ["HEAD", "--", ...pathspec]);
    if (!numstat) return undefined;

    const trackedPaths = newPaths.filter((path) => nameStatus.has(path));
    const untrackedPaths = newPaths.filter((path) => !nameStatus.has(path));
    const files: AutoReviewChangeFile[] = [];
    const chunks: Array<{ path: string; text: string }> = [];

    for (const path of trackedPaths) {
      const info = nameStatus.get(path);
      const status = info ? mapStatus(info.code) : "unknown";
      const stat = numstat.get(path);
      files.push({
        path,
        ...(info?.oldPath ? { oldPath: info.oldPath } : {}),
        status,
        lines: stat ? stat.additions + stat.deletions : 0,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      });
      const diffArgs = info?.oldPath
        ? ["diff", "--binary", "--no-color", "HEAD", "--", info.oldPath, path]
        : ["diff", "--binary", "--no-color", "HEAD", "--", path];
      const text = await this.readDiffText(cwd, diffArgs);
      if (text === undefined) return undefined;
      chunks.push({ path, text });
    }

    for (const path of untrackedPaths) {
      const stat = await this.countUntrackedLines(cwd, path);
      files.push({
        path,
        status: "added",
        lines: stat.additions + stat.deletions,
        additions: stat.additions,
        deletions: stat.deletions,
      });
      const text = await this.readDiffText(cwd, [
        "diff",
        "--no-index",
        "--binary",
        "--no-color",
        "--",
        "/dev/null",
        path,
      ]);
      if (text === undefined) return undefined;
      chunks.push({ path, text });
    }

    const { patch, truncated } = assemblePatch(chunks);
    return {
      files: sortFiles(files),
      attribution: "complete",
      baseHead: state.head,
      head: state.head,
      patch,
      patchTruncated: truncated,
    };
  }

  private async buildCommitChangeSet(
    cwd: string,
    baseHead: string,
    head: string,
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable | undefined> {
    const nameStatus = await this.readNameStatus(cwd, [baseHead, head]);
    if (!nameStatus) return undefined;
    if (hasSensitiveContentPath([...nameStatus.keys()], nameStatus)) {
      return unavailable("sensitive_content_path");
    }
    const numstat = await this.readNumstat(cwd, [baseHead, head]);
    if (!numstat) return undefined;

    const files: AutoReviewChangeFile[] = [];
    for (const [path, info] of nameStatus) {
      const stat = numstat.get(path);
      files.push({
        path,
        ...(info.oldPath ? { oldPath: info.oldPath } : {}),
        status: mapStatus(info.code),
        lines: stat ? stat.additions + stat.deletions : 0,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      });
    }

    const text = await this.readDiffText(cwd, ["diff", "--binary", "--no-color", baseHead, head]);
    if (text === undefined) return undefined;
    const { patch, truncated } = assemblePatch([{ path: "", text }]);
    return {
      files: sortFiles(files),
      attribution: "complete",
      baseHead,
      head,
      patch,
      patchTruncated: truncated,
    };
  }

  private async collect(
    state: RepoState,
    cwd: string,
    paths: string[],
  ): Promise<CollectedEntries | undefined> {
    const entries: Record<string, GitDirtyEntry> = Object.create(null);
    const hashes: Record<string, string | "missing"> = Object.create(null);
    for (const path of paths) {
      const status = state.statusByPath.get(path) ?? "";
      if (isUnmergedStatus(status)) return undefined;
      const indexEntry = state.index.get(path);
      const indexMode = indexEntry?.mode ?? "missing";
      if (indexMode === SYMLINK_MODE || indexMode === GITLINK_MODE) return undefined;
      const worktreeHash = await hashWorktree(this.executor, cwd, path);
      hashes[path] = worktreeHash;
      entries[path] = {
        status,
        worktreeHash,
        indexHash: indexEntry?.hash ?? "missing",
        indexMode,
      };
    }
    return { entries, hashes };
  }

  private async isAncestor(cwd: string, base: string, head: string): Promise<boolean> {
    const result = await this.executor.exec(["merge-base", "--is-ancestor", base, head], cwd);
    return result.code === 0;
  }

  private async readNameStatus(
    cwd: string,
    range: string[],
  ): Promise<Map<string, { code: string; oldPath?: string }> | undefined> {
    const result = await this.executor.exec(
      ["diff", "--name-status", "-z", "--no-color", ...range],
      cwd,
    );
    if (result.code !== 0 && result.code !== 1) return undefined;
    return parseNameStatus(result.stdout);
  }

  private async readNumstat(cwd: string, range: string[]): Promise<Map<string, NumstatEntry> | undefined> {
    const result = await this.executor.exec(
      ["diff", "--numstat", "-z", "--no-color", ...range],
      cwd,
    );
    if (result.code !== 0 && result.code !== 1) return undefined;
    return parseNumstat(result.stdout);
  }

  private async readDiffText(cwd: string, args: string[]): Promise<string | undefined> {
    const result = await this.executor.exec(args, cwd);
    if (result.code !== 0 && result.code !== 1) return undefined;
    return result.stdout.toString("utf8");
  }

  private async countUntrackedLines(cwd: string, path: string): Promise<NumstatEntry> {
    const result = await this.executor.exec(
      ["diff", "--no-index", "--numstat", "-z", "--no-color", "--", "/dev/null", path],
      cwd,
    );
    const parsed = parseNumstat(result.stdout);
    return parsed?.get(path) ?? { additions: 0, deletions: 0 };
  }
}

function isUnavailable(value: GitRunChangeSet | GitRunChangeUnavailable): value is GitRunChangeUnavailable {
  return value.attribution === "unavailable";
}

function hasSensitiveContentPath(
  paths: string[],
  nameStatus: Map<string, { code: string; oldPath?: string }>,
): boolean {
  return paths.some((path) => {
    const oldPath = nameStatus.get(path)?.oldPath;
    return isSensitiveContentPath(path) || (oldPath !== undefined && isSensitiveContentPath(oldPath));
  });
}

function isSensitiveContentPath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /^\.env(?:\.|$)/.test(name)
    || name === ".npmrc"
    || name === ".pypirc"
    || name === "credentials.json"
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name);
}

function unavailable(reason: AutoReviewReason): GitRunChangeUnavailable {
  return { attribution: "unavailable", reason };
}

async function hashWorktree(
  executor: GitExecutor,
  cwd: string,
  path: string,
): Promise<string | "missing"> {
  const result = await executor.exec(["hash-object", "--", path], cwd);
  if (result.code !== 0) return "missing";
  const value = result.stdout.toString("utf8").trim();
  return HASH_PATTERN.test(value) ? value : "missing";
}

async function readRepoState(
  executor: GitExecutor,
  cwd: string,
): Promise<RepoState | "no-repo" | undefined> {
  const root = await executor.exec(["rev-parse", "--show-toplevel"], cwd);
  if (root.code !== 0) return "no-repo";
  let rootPath: string;
  try {
    // rev-parse appends LF; spaces and backslashes belong to the returned path.
    rootPath = new TextDecoder("utf-8", { fatal: true }).decode(root.stdout).replace(/\n$/, "");
  } catch { return undefined; }
  if (!rootPath) return undefined;
  cwd = rootPath;

  const head = await executor.exec(["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const headValue = decodeTrimmed(head.stdout);
  if (headValue === undefined || headValue.length === 0) return undefined;

  const status = await executor.exec(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
  );
  if (status.code !== 0) return undefined;
  const entries = parseStatus(status.stdout);
  if (!entries) return undefined;

  const index = await executor.exec(["ls-files", "-s", "-z"], cwd);
  if (index.code !== 0) return undefined;
  const indexMap = parseIndex(index.stdout);
  if (!indexMap) return undefined;

  const statusByPath = new Map<string, string>();
  for (const entry of entries) statusByPath.set(entry.path, entry.status);

  return {
    // Git already emits its separators; a POSIX backslash is a filename character.
    root: rootPath,
    head: headValue,
    statusRaw: status.stdout,
    entries,
    statusByPath,
    index: indexMap,
  };
}
