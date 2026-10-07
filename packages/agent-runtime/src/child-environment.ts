import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getConfigDir,
  resolveGitRepository,
  type AgentChildSpawnInput,
  type AgentChildResult,
} from "@vykor/core";

export interface AgentChildEnvironmentLease {
  cwd: string;
  worktree?: { path: string; branch: string };
  release(result: AgentChildResult): Promise<void>;
}

export interface AgentChildEnvironmentProvider {
  acquire(
    input: AgentChildSpawnInput,
    childId: string,
  ): Promise<AgentChildEnvironmentLease>;
}

export interface ChildAgentWorktreeManager {
  isGitRepo(): Promise<boolean>;
  create(
    slug: string,
  ): Promise<{ slug: string; path: string; branch: string; created: boolean }>;
  hasChanges(slug: string): Promise<boolean>;
  remove(
    slug: string,
    opts?: { force?: boolean; discardUnmerged?: boolean },
  ): Promise<void>;
}

export interface GitRunner {
  (
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Kernel 默认环境：沿用调用方给出的 cwd，不读取 Git，也不创建 worktree。 */
export function createInProcessChildEnvironmentProvider(): AgentChildEnvironmentProvider {
  return {
    async acquire(input) {
      return staticLease(input.cwd);
    },
  };
}

/** 默认 Node 环境：明确允许在 isolate=true 时使用 Git worktree。 */
export function createDefaultChildEnvironmentProvider(
  options: {
    autoCleanup?: boolean;
    branchPrefix?: string;
    configDir?: string;
  } = {},
): AgentChildEnvironmentProvider {
  return {
    async acquire(input) {
      if (!input.isolate) return staticLease(input.cwd);
      const manager = createChildAgentWorktreeManager({
        cwd: input.cwd,
        branchPrefix: options.branchPrefix,
        configDir: options.configDir,
      });
      if (!(await manager.isGitRepo()))
        throw new Error(
          "Child worktree isolation requires a Git repository; cannot fall back to the current directory",
        );
      const slug = buildChildAgentWorktreeSlug({
        team: input.team ?? "default",
        agent: input.agent,
      });
      const created = await manager.create(slug);
      return {
        cwd: created.path,
        worktree: { path: created.path, branch: created.branch },
        async release(result) {
          if (!created.created || options.autoCleanup !== true) return;
          if (
            !result ||
            !["completed", "failed", "interrupted", "stopped"].includes(
              result.status,
            )
          )
            return;
          await manager.remove(created.slug).catch(() => {});
        },
      };
    },
  };
}

function staticLease(cwd: string): AgentChildEnvironmentLease {
  return { cwd, release: async () => {} };
}

interface WorktreeListEntry {
  slug?: string;
  path: string;
  branch?: string;
}

export function createChildAgentWorktreeManager(input: {
  cwd: string;
  configDir?: string;
  runGit?: GitRunner;
  branchPrefix?: string;
}): ChildAgentWorktreeManager {
  const repoRoot = resolveGitRepository(input.cwd)?.root ?? input.cwd;
  return new WorktreeManager({
    runGit: input.runGit ?? nodeRunGit,
    repoRoot,
    baseDir: computeChildAgentWorktreeBaseDir(
      repoRoot,
      input.configDir ?? getConfigDir(),
    ),
    branchPrefix: input.branchPrefix ?? "worktree-",
  });
}

export function buildChildAgentWorktreeSlug(input: {
  team: string;
  agent: string;
  nonce?: string;
}): string {
  const rawSlug =
    `${input.team}-${input.agent}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const suffix = `${createHash("sha1").update(rawSlug).digest("hex").slice(0, 8)}-${input.nonce ?? randomUUID().slice(0, 8)}`;
  return `${rawSlug.slice(0, MAX_WORKTREE_SLUG_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function computeChildAgentWorktreeBaseDir(
  repoRoot: string,
  configDir: string,
): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const key =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const repoId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(configDir, "worktrees", repoId);
}

const VALID_WORKTREE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

class WorktreeManager implements ChildAgentWorktreeManager {
  private readonly created = new Map<
    string,
    { path: string; branch: string; baseCommit: string }
  >();
  constructor(
    private readonly options: {
      runGit: GitRunner;
      baseDir: string;
      repoRoot: string;
      branchPrefix: string;
    },
  ) {}

  async isGitRepo(): Promise<boolean> {
    const { code, stdout } = await this.options.runGit(
      ["rev-parse", "--is-inside-work-tree"],
      this.options.repoRoot,
    );
    return code === 0 && stdout.trim() === "true";
  }

  async create(
    slug: string,
  ): Promise<{ slug: string; path: string; branch: string; created: boolean }> {
    const normalizedSlug = validateWorktreeSlug(slug);
    const path = join(
      this.options.baseDir,
      flattenWorktreeSlug(normalizedSlug),
    );
    const existing = await this.list();
    const reused = existing.find((entry) => samePath(entry.path, path));
    if (reused) {
      if (!reused.branch)
        throw new Error(
          "Cannot reuse a worktree whose branch cannot be verified",
        );
      return {
        slug: normalizedSlug,
        path,
        branch: reused.branch,
        created: false,
      };
    }
    const baseName = `${this.options.branchPrefix}${flattenWorktreeSlug(normalizedSlug)}`;
    const validation = await this.options.runGit(
      ["check-ref-format", "--branch", baseName],
      this.options.repoRoot,
    );
    if (validation.code !== 0)
      throw new Error(
        `Invalid child worktree branch: ${validation.stderr.trim()}`,
      );
    const refs = await this.options.runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      this.options.repoRoot,
    );
    if (refs.code !== 0)
      throw new Error(
        `Cannot inspect existing branches: ${refs.stderr.trim()}`,
      );
    const branches = new Set(refs.stdout.trim().split(/\r?\n/));
    let branch = baseName;
    for (let suffix = 2; branches.has(branch); suffix++)
      branch = `${baseName}-${suffix}`;
    const baseline = await this.options.runGit(
      ["rev-parse", "HEAD"],
      this.options.repoRoot,
    );
    if (baseline.code !== 0 || !baseline.stdout.trim())
      throw new Error(
        "Cannot create a worktree without a verified HEAD commit",
      );
    const { code, stderr } = await this.options.runGit(
      ["worktree", "add", "-b", branch, path, "HEAD"],
      this.options.repoRoot,
    );
    if (code !== 0)
      throw new Error(`git worktree add failed: ${stderr.trim()}`);
    this.created.set(normalizedSlug, {
      path,
      branch,
      baseCommit: baseline.stdout.trim(),
    });
    return { slug: normalizedSlug, path, branch, created: true };
  }

  async hasChanges(slug: string): Promise<boolean> {
    const path = join(
      this.options.baseDir,
      flattenWorktreeSlug(validateWorktreeSlug(slug)),
    );
    const { code, stdout, stderr } = await this.options.runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      path,
    );
    if (code !== 0)
      throw new Error(
        `Cannot verify child worktree contents: ${stderr.trim()}`,
      );
    return stdout.trim().length > 0;
  }

  async remove(
    slug: string,
    opts?: { force?: boolean; discardUnmerged?: boolean },
  ): Promise<void> {
    if (opts?.force)
      throw new Error("Force removal of child worktrees is not supported");
    const normalizedSlug = validateWorktreeSlug(slug);
    const owned = this.created.get(normalizedSlug);
    if (!owned)
      throw new Error("Cannot remove a worktree not created by this manager");
    const registered = (await this.list()).find((entry) =>
      samePath(entry.path, owned.path),
    );
    if (!registered || registered.branch !== owned.branch)
      throw new Error(
        "Child worktree registration or branch changed; retain the directory",
      );
    if (await this.hasChanges(normalizedSlug))
      throw new Error(
        "Child worktree has uncommitted contents; retain the directory",
      );
    const head = await this.options.runGit(["rev-parse", "HEAD"], owned.path);
    if (head.code !== 0 || !head.stdout.trim())
      throw new Error("Cannot verify child worktree results");
    if (
      head.stdout.trim() !== owned.baseCommit &&
      opts?.discardUnmerged !== true
    ) {
      const preserved = await this.options.runGit(
        [
          "for-each-ref",
          `--contains=${head.stdout.trim()}`,
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes",
        ],
        this.options.repoRoot,
      );
      if (
        preserved.code !== 0 ||
        !preserved.stdout
          .trim()
          .split(/\r?\n/)
          .some((branch) => branch && branch !== owned.branch)
      )
        throw new Error(
          "Child worktree has unmerged results; retain the directory",
        );
    }
    const { code, stderr } = await this.options.runGit(
      ["worktree", "remove", "--", owned.path],
      this.options.repoRoot,
    );
    if (code !== 0)
      throw new Error(`git worktree remove failed: ${stderr.trim()}`);
    this.created.delete(normalizedSlug);
  }

  private async list(): Promise<WorktreeListEntry[]> {
    const { code, stdout } = await this.options.runGit(
      ["worktree", "list", "--porcelain"],
      this.options.repoRoot,
    );
    if (code !== 0) throw new Error("Cannot verify registered worktrees");
    return parseWorktreePorcelain(stdout, this.options.baseDir);
  }
}

function validateWorktreeSlug(slug: string): string {
  if (!slug) throw new Error("Worktree slug must not be empty");
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Worktree slug must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer`,
    );
  }
  if (slug.startsWith("/") || slug.startsWith("\\")) {
    throw new Error(
      `Worktree slug must not be an absolute path: ${JSON.stringify(slug)}`,
    );
  }
  for (const segment of slug.split("/")) {
    if (
      segment === "." ||
      segment === ".." ||
      !VALID_WORKTREE_SEGMENT.test(segment)
    ) {
      throw new Error(`Invalid worktree slug: ${JSON.stringify(slug)}`);
    }
  }
  return slug;
}

function flattenWorktreeSlug(slug: string): string {
  return slug.replace(/\//g, "+");
}

function parseWorktreePorcelain(
  stdout: string,
  baseDir: string,
): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  const baseNorm = normalizePath(baseDir);
  const flush = () => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      flush();
      const path = line.slice("worktree ".length).trim();
      current = { path };
      const pathNorm = normalizePath(path);
      if (pathNorm.startsWith(`${baseNorm}/`))
        current.slug = pathNorm.slice(baseNorm.length + 1).replace(/\+/g, "/");
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

const nodeRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) =>
      resolve({ code: 127, stdout, stderr: stderr || error.message }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
