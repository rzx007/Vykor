import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const runtimePaths = vi.hoisted(() => ({ configDir: "" }));

vi.mock("@vykor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vykor/core")>();
  return {
    ...actual,
    getConfigDir: () => runtimePaths.configDir,
    resolveGitRepository: (cwd: string) => ({ root: cwd, gitDir: join(cwd, ".git") }),
  };
});

import {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
  createDefaultChildEnvironmentProvider,
  type GitRunner,
} from "./child-environment.js";

describe("child environment worktrees", () => {
  it("builds stable safe directory keys and bounded unique slugs", () => {
    const base = computeChildAgentWorktreeBaseDir("C:\\Repo\\Project", "C:\\config");
    const first = buildChildAgentWorktreeSlug({ team: "Core Team", agent: "Explore", nonce: "one" });
    const second = buildChildAgentWorktreeSlug({ team: "Core Team", agent: "Explore", nonce: "two" });

    expect(base).toContain("worktrees");
    expect(first).toMatch(/^core-team-explore-/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
  });

  it("reuses an already-listed worktree without adding it again", async () => {
    const baseDir = computeChildAgentWorktreeBaseDir("/repo", "/config");
    const expectedPath = join(baseDir, "team+agent-123");
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: `worktree ${expectedPath}\nHEAD abcdef\nbranch refs/heads/worktree-team+agent-123\n\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const manager = createChildAgentWorktreeManager({ cwd: "/repo", configDir: "/config", runGit });

    const reused = await manager.create("team/agent-123");

    expect(reused).toEqual({
      slug: "team/agent-123",
      path: expectedPath,
      branch: "worktree-team+agent-123",
      created: false,
    });
    expect(runGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add"]),
      expect.any(String),
    );
  });

  it.runIf(process.platform === "win32")(
    "reuses a listed worktree when Windows slash and casing differ",
    async () => {
      const baseDir = computeChildAgentWorktreeBaseDir("C:\\Repo", "C:\\Config");
      const expectedPath = join(baseDir, "team+agent-123");
      const listedPath = expectedPath.replace(/\\/g, "/").toUpperCase();
      const runGit = vi.fn(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return { code: 0, stdout: `worktree ${listedPath}\n\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const manager = createChildAgentWorktreeManager({ cwd: "C:\\Repo", configDir: "C:\\Config", runGit });

      expect((await manager.create("team/agent-123")).created).toBe(false);
      expect(runGit).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]), expect.any(String));
    },
  );
});

const realRunGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  const child = spawn("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data.toString(); });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

describe("default child environment worktree release", () => {
  let tmpRoot: string;
  let repoRoot: string;
  let worktreePath: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "oh-child-worktree-"));
    repoRoot = join(tmpRoot, "repo");
    runtimePaths.configDir = join(tmpRoot, "config");
    await mkdir(repoRoot, { recursive: true });
    await realRunGit(["init", "-b", "main"], repoRoot);
    await realRunGit(["config", "user.email", "test@example.test"], repoRoot);
    await realRunGit(["config", "user.name", "Runtime test"], repoRoot);
    await writeFile(join(repoRoot, "README.md"), "initial\n");
    await realRunGit(["add", "."], repoRoot);
    await realRunGit(["commit", "-m", "initial"], repoRoot);
  });

  afterEach(async () => {
    if (worktreePath) await realRunGit(["worktree", "remove", "--force", worktreePath], repoRoot);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("removes a clean newly-created isolated worktree on release", async () => {
    const lease = await createDefaultChildEnvironmentProvider().acquire({
      description: "test child",
      prompt: "test",
      agent: "worker",
      team: "team",
      cwd: repoRoot,
      isolate: true,
    }, "child-1");
    worktreePath = lease.worktree?.path;

    expect(lease.worktree).toBeDefined();
    await lease.release({ status: "completed", output: "" });

    const listed = await realRunGit(["worktree", "list", "--porcelain"], repoRoot);
    expect(listed.stdout.replace(/\\/g, "/")).not.toContain(lease.cwd.replace(/\\/g, "/"));
  });

  it("retains a dirty newly-created isolated worktree on release", async () => {
    const lease = await createDefaultChildEnvironmentProvider().acquire({
      description: "test child",
      prompt: "test",
      agent: "worker",
      team: "team",
      cwd: repoRoot,
      isolate: true,
    }, "child-1");
    worktreePath = lease.worktree?.path;
    await writeFile(join(lease.cwd, "dirty.txt"), "uncommitted\n");

    await lease.release({ status: "completed", output: "" });

    const listed = await realRunGit(["worktree", "list", "--porcelain"], repoRoot);
    expect(listed.stdout.replace(/\\/g, "/")).toContain(lease.cwd.replace(/\\/g, "/"));
  });
});
