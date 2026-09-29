import { execFile } from "node:child_process";

import type { AutoReviewReason } from "@vykor/protocol";

import type { AutoReviewChangeFile, AutoReviewChangeSet } from "./auto-review-policy.js";

export const GIT_PATCH_LIMIT_BYTES = 512 * 1024;

const GIT_INSPECTION_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
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

interface StatusEntry {
  path: string;
  oldPath?: string;
  status: string;
}

interface RepoState {
  root: string;
  head: string;
  statusRaw: Buffer;
  entries: StatusEntry[];
  statusByPath: Map<string, string>;
  index: Map<string, { hash: string; mode: string }>;
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

    let result: GitRunChangeSet | undefined;
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
      const newPaths = currentPaths.filter((path) => !(path in baseline.dirty));
      const contextPaths = first.entries
        .map((entry) => entry.oldPath)
        .filter((path): path is string => path !== undefined && !(path in baseline.dirty));
      result = await this.buildWorktreeChangeSet(cwd, first, newPaths, contextPaths);
    } else {
      const ancestor = await this.isAncestor(cwd, baseline.head, first.head);
      if (!ancestor) return unavailable("non_linear_head_change");
      const currentDirty: Record<string, GitDirtyEntry> = {};
      for (const path of currentPaths) currentDirty[path] = collected.entries[path]!;
      if (!sameDirtyMap(currentDirty, baseline.dirty)) {
        return unavailable("post_commit_worktree_changed");
      }
      result = await this.buildCommitChangeSet(cwd, baseline.head, first.head);
    }
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
  ): Promise<GitRunChangeSet | undefined> {
    const pathspec = uniquePaths([...newPaths, ...contextPaths]);

    const nameStatus = await this.readNameStatus(cwd, ["HEAD", "--", ...pathspec]);
    if (!nameStatus) return undefined;
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
  ): Promise<GitRunChangeSet | undefined> {
    const nameStatus = await this.readNameStatus(cwd, [baseHead, head]);
    if (!nameStatus) return undefined;
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
    const entries: Record<string, GitDirtyEntry> = {};
    const hashes: Record<string, string | "missing"> = {};
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

function buildDigest(
  state: RepoState,
  paths: string[],
  hashes: Record<string, string | "missing">,
): string {
  const sorted = uniquePaths(paths).sort();
  const parts = [state.root, state.head, state.statusRaw.toString("base64")];
  for (const path of sorted) {
    const indexEntry = state.index.get(path);
    parts.push(
      `${path}\u0001${indexEntry ? `${indexEntry.mode} ${indexEntry.hash}` : "missing"}\u0001${
        hashes[path] ?? "missing"
      }`,
    );
  }
  return parts.join("\u0002");
}

function parseStatus(buffer: Buffer): StatusEntry[] | undefined {
  const records = splitNul(buffer);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== 0x20) return undefined;
    const status = record.subarray(0, 2).toString("latin1");
    const path = decodeField(record.subarray(3));
    if (path === undefined) return undefined;
    const entry: StatusEntry = { path, status };
    if (status[0] === "R" || status[0] === "C") {
      const oldRecord = records[index + 1];
      if (oldRecord === undefined) return undefined;
      const oldPath = decodeField(oldRecord);
      if (oldPath === undefined) return undefined;
      entry.oldPath = oldPath;
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function parseIndex(buffer: Buffer): Map<string, { hash: string; mode: string }> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, { hash: string; mode: string }>();
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) return undefined;
    const meta = record.subarray(0, tab).toString("latin1").split(" ");
    const mode = meta[0] ?? "";
    const hash = meta[1] ?? "";
    const path = decodeField(record.subarray(tab + 1));
    if (path === undefined || mode.length === 0 || hash.length === 0) return undefined;
    map.set(path, { hash, mode });
  }
  return map;
}

function parseNameStatus(
  buffer: Buffer,
): Map<string, { code: string; oldPath?: string }> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, { code: string; oldPath?: string }>();
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index]!.toString("latin1");
    if (code.length === 0) return undefined;
    const first = records[index + 1];
    if (first === undefined) return undefined;
    const firstPath = decodeField(first);
    if (firstPath === undefined) return undefined;
    if (code[0] === "R" || code[0] === "C") {
      const second = records[index + 2];
      if (second === undefined) return undefined;
      const newPath = decodeField(second);
      if (newPath === undefined) return undefined;
      map.set(newPath, { code, oldPath: firstPath });
      index += 2;
    } else {
      map.set(firstPath, { code });
      index += 1;
    }
  }
  return map;
}

function parseNumstat(buffer: Buffer): Map<string, number> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const parts = record.toString("latin1").split("\t");
    if (parts.length < 3) return undefined;
    const added = parts[0]!;
    const deleted = parts[1]!;
    const inlinePath = parts.slice(2).join("\t");
    const lineCount = (isBinaryCount(added) ? 0 : Number(added)) + (isBinaryCount(deleted) ? 0 : Number(deleted));
    if (inlinePath.length > 0) {
      const path = decodeField(Buffer.from(inlinePath, "latin1"));
      if (path === undefined) return undefined;
      map.set(path, lineCount);
    } else {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (oldPath === undefined || newPath === undefined) return undefined;
      const decoded = decodeField(newPath);
      if (decoded === undefined) return undefined;
      map.set(decoded, lineCount);
      index += 2;
    }
  }
  return map;
}

function assemblePatch(chunks: Array<{ path: string; text: string }>): {
  patch: string;
  truncated: boolean;
} {
  const sorted = [...chunks].sort((left, right) =>
    normalizePath(left.path).localeCompare(normalizePath(right.path)),
  );
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (const chunk of sorted) {
    const buffer = Buffer.from(chunk.text, "utf8");
    const remaining = GIT_PATCH_LIMIT_BYTES - size;
    if (buffer.length <= remaining) {
      parts.push(buffer);
      size += buffer.length;
      continue;
    }
    if (remaining > 0) parts.push(buffer.subarray(0, remaining));
    size = GIT_PATCH_LIMIT_BYTES;
    truncated = true;
    break;
  }
  return { patch: Buffer.concat(parts).toString("utf8"), truncated };
}

function sortFiles(files: AutoReviewChangeFile[]): AutoReviewChangeFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function sameDirtyMap(
  left: Record<string, GitDirtyEntry>,
  right: Record<string, GitDirtyEntry>,
): boolean {
  return serializeDirty(left) === serializeDirty(right);
}

function serializeDirty(dirty: Record<string, GitDirtyEntry>): string {
  return Object.keys(dirty)
    .sort()
    .map((path) => {
      const entry = dirty[path]!;
      return `${path}\u0001${entry.status}\u0001${entry.worktreeHash}\u0001${entry.indexHash}\u0001${entry.indexMode}`;
    })
    .join("\u0002");
}

function mapStatus(code: string): AutoReviewChangeFile["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

function isUnmergedStatus(status: string): boolean {
  return status.includes("U") || status === "DD" || status === "AA";
}

function isBinaryCount(value: string): boolean {
  return value === "-";
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function decodeField(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (CONTROL_CHARACTER_PATTERN.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function decodeTrimmed(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
  } catch {
    return undefined;
  }
}

function toGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
