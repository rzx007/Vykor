import { execFile } from "node:child_process";

import type { AutoReviewReason } from "@vykor/protocol";

import type { AutoReviewChangeFile, AutoReviewChangeSet } from "./auto-review-policy.js";
import {
  assemblePatch,
  buildDigest,
  decodeTrimmed,
  isUnmergedStatus,
  mapStatus,
  normalizePath,
  parseIndex,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  sameDirtyMap,
  sortFiles,
  toGitPath,
  uniquePaths,
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
  exec(args: string[], cwd: string): Promise<GitRunResult>;
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
  capture(cwd: string): Promise<GitRunBaseline | GitRunChangeUnavailable>;
  compare(
    cwd: string,
    baseline: GitRunBaseline,
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable>;
}

export function createExecFileGitExecutor(): GitExecutor {
  return {
    exec(args, cwd) {
      return new Promise<GitRunResult>((resolve) => {
        execFile(
          "git",
          args,
          {
            cwd,
            windowsHide: true,
            timeout: GIT_INSPECTION_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
            encoding: "buffer",
          },
          (error, stdout, stderr) => {
            const code =
              typeof (error as { code?: unknown } | null)?.code === "number"
                ? ((error as { code: number }).code)
                : error
                  ? 1
                  : 0;
            resolve({
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
              stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
              code,
            });
          },
        );
      });
    },
  };
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

  async capture(cwd: string): Promise<GitRunBaseline | GitRunChangeUnavailable> {
    const first = await readRepoState(this.executor, cwd);
    if (first === "no-repo") return unavailable("not_git_repository");
    if (!first) return unavailable("git_inspection_failed");

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
  ): Promise<GitRunChangeSet | GitRunChangeUnavailable> {
    const first = await readRepoState(this.executor, cwd);
    if (!first || first === "no-repo") return unavailable("git_inspection_failed");
    if (first.root !== baseline.repositoryRoot) return unavailable("git_inspection_failed");

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
      files.push({
        path: normalizePath(path),
        ...(info?.oldPath ? { oldPath: normalizePath(info.oldPath) } : {}),
        status,
        lines: numstat.get(path) ?? 0,
      });
      const diffArgs = info?.oldPath
        ? ["diff", "--binary", "--no-color", "HEAD", "--", info.oldPath, path]
        : ["diff", "--binary", "--no-color", "HEAD", "--", path];
      const text = await this.readDiffText(cwd, diffArgs);
      if (text === undefined) return undefined;
      chunks.push({ path, text });
    }

    for (const path of untrackedPaths) {
      files.push({ path: normalizePath(path), status: "added", lines: await this.countUntrackedLines(cwd, path) });
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
      files.push({
        path: normalizePath(path),
        ...(info.oldPath ? { oldPath: normalizePath(info.oldPath) } : {}),
        status: mapStatus(info.code),
        lines: numstat.get(path) ?? 0,
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

  private async readNumstat(cwd: string, range: string[]): Promise<Map<string, number> | undefined> {
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

  private async countUntrackedLines(cwd: string, path: string): Promise<number> {
    const result = await this.executor.exec(
      ["diff", "--no-index", "--numstat", "-z", "--no-color", "--", "/dev/null", path],
      cwd,
    );
    const parsed = parseNumstat(result.stdout);
    return parsed?.get(path) ?? 0;
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
  const result = await executor.exec(["hash-object", "--", toGitPath(path)], cwd);
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
  const rootPath = decodeTrimmed(root.stdout);
  if (rootPath === undefined) return undefined;

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
    root: normalizePath(rootPath),
    head: headValue,
    statusRaw: status.stdout,
    entries,
    statusByPath,
    index: indexMap,
  };
}
