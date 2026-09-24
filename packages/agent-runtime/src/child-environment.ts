import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { getConfigDir, resolveGitRepository, type AgentChildSpawnInput, type AgentChildResult } from "@vykor/core";

export interface AgentChildEnvironmentLease {
  cwd: string;
  worktree?: { path: string; branch: string };
  release(result: AgentChildResult): Promise<void>;
}

export interface AgentChildEnvironmentProvider {
  acquire(input: AgentChildSpawnInput, childId: string): Promise<AgentChildEnvironmentLease>;
}

export interface ChildAgentWorktreeManager {
  isGitRepo(): Promise<boolean>;
  create(slug: string): Promise<{ slug: string; path: string; branch: string; created: boolean }>;
  hasChanges(slug: string): Promise<boolean>;
  remove(slug: string, opts?: { force?: boolean }): Promise<void>;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
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
export function createDefaultChildEnvironmentProvider(): AgentChildEnvironmentProvider {
  return {
    async acquire(input) {
      if (!input.isolate) return staticLease(input.cwd);
      const manager = createChildAgentWorktreeManager({ cwd: input.cwd });
      if (!await manager.isGitRepo()) return staticLease(input.cwd);
      const slug = buildChildAgentWorktreeSlug({
        team: input.team ?? "default",
        agent: input.agent,
      });
      const created = await manager.create(slug);
      return {
        cwd: created.path,
        worktree: { path: created.path, branch: created.branch },
        async release() {
          if (!created.created) return;
          const hasChanges = await manager.hasChanges(created.slug).catch(() => true);
          if (!hasChanges) await manager.remove(created.slug).catch(() => {});
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
}): ChildAgentWorktreeManager {
  const repoRoot = resolveGitRepository(input.cwd)?.root ?? input.cwd;
  return new WorktreeManager({
    runGit: input.runGit ?? nodeRunGit,
    repoRoot,
    baseDir: computeChildAgentWorktreeBaseDir(repoRoot, input.configDir ?? getConfigDir()),
  });
}

export function buildChildAgentWorktreeSlug(input: {
  team: string;
  agent: string;
  nonce?: string;
}): string {
  const rawSlug = `${input.team}-${input.agent}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
  const suffix = `${createHash("sha1").update(rawSlug).digest("hex").slice(0, 8)}-${input.nonce ?? randomUUID().slice(0, 8)}`;
  return `${rawSlug.slice(0, MAX_WORKTREE_SLUG_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function computeChildAgentWorktreeBaseDir(repoRoot: string, configDir: string): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const repoId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(configDir, "worktrees", repoId);
}

const VALID_WORKTREE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

class WorktreeManager implements ChildAgentWorktreeManager {
  constructor(private readonly options: { runGit: GitRunner; baseDir: string; repoRoot: string }) {}

  async isGitRepo(): Promise<boolean> {
    const { code, stdout } = await this.options.runGit(["rev-parse", "--is-inside-work-tree"], this.options.repoRoot);
    return code === 0 && stdout.trim() === "true";
  }

  async create(slug: string): Promise<{ slug: string; path: string; branch: string; created: boolean }> {
    const normalizedSlug = validateWorktreeSlug(slug);
    const path = join(this.options.baseDir, flattenWorktreeSlug(normalizedSlug));
    const branch = worktreeBranch(normalizedSlug);
    const existing = await this.list();
    if (existing.some((entry) => samePath(entry.path, path))) {
      return { slug: normalizedSlug, path, branch, created: false };
    }
    const { code, stderr } = await this.options.runGit(
      ["worktree", "add", "-B", branch, path, "HEAD"],
      this.options.repoRoot,
    );
    if (code !== 0) throw new Error(`git worktree add failed: ${stderr.trim()}`);
    return { slug: normalizedSlug, path, branch, created: true };
  }

  async hasChanges(slug: string): Promise<boolean> {
    const path = join(this.options.baseDir, flattenWorktreeSlug(validateWorktreeSlug(slug)));
    const { code, stdout } = await this.options.runGit(["status", "--porcelain"], path);
    return code === 0 && stdout.trim().length > 0;
  }

  async remove(slug: string, opts?: { force?: boolean }): Promise<void> {
    const path = join(this.options.baseDir, flattenWorktreeSlug(validateWorktreeSlug(slug)));
    const args = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(path);
    const { code, stderr } = await this.options.runGit(args, this.options.repoRoot);
    if (code !== 0) throw new Error(`git worktree remove failed: ${stderr.trim()}`);
  }

  private async list(): Promise<WorktreeListEntry[]> {
    const { code, stdout } = await this.options.runGit(["worktree", "list", "--porcelain"], this.options.repoRoot);
    return code === 0 ? parseWorktreePorcelain(stdout, this.options.baseDir) : [];
  }
}

function validateWorktreeSlug(slug: string): string {
  if (!slug) throw new Error("Worktree slug must not be empty");
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(`Worktree slug must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer`);
  }
  if (slug.startsWith("/") || slug.startsWith("\\")) {
    throw new Error(`Worktree slug must not be an absolute path: ${JSON.stringify(slug)}`);
  }
  for (const segment of slug.split("/")) {
    if (segment === "." || segment === ".." || !VALID_WORKTREE_SEGMENT.test(segment)) {
      throw new Error(`Invalid worktree slug: ${JSON.stringify(slug)}`);
    }
  }
  return slug;
}

function flattenWorktreeSlug(slug: string): string {
  return slug.replace(/\//g, "+");
}

function worktreeBranch(slug: string): string {
  return `worktree-${flattenWorktreeSlug(slug)}`;
}

function parseWorktreePorcelain(stdout: string, baseDir: string): WorktreeListEntry[] {
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
      if (pathNorm.startsWith(`${baseNorm}/`)) current.slug = pathNorm.slice(baseNorm.length + 1).replace(/\+/g, "/");
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
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

const nodeRunGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  const child = spawn("git", args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => { stdout += data.toString(); });
  child.stderr?.on("data", (data) => { stderr += data.toString(); });
  child.on("error", (error) => resolve({ code: 127, stdout, stderr: stderr || error.message }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
});
