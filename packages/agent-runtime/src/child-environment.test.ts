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
    resolveGitRepository: (cwd: string) => ({
      root: cwd,
      gitDir: join(cwd, ".git"),
    }),
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
    const base = computeChildAgentWorktreeBaseDir(
      "C:\\Repo\\Project",
      "C:\\config",
    );
    const first = buildChildAgentWorktreeSlug({
      team: "Core Team",
      agent: "Explore",
      nonce: "one",
    });
    const second = buildChildAgentWorktreeSlug({
      team: "Core Team",
      agent: "Explore",
      nonce: "two",
    });

    expect(base).toContain("worktrees");
    expect(first).toMatch(/^core-team-explore-/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
  });

  it("reuses an already-listed worktree without adding it again", async () => {
    const baseDir = computeChildAgentWorktreeBaseDir("/repo", "/config");
    const expectedPath = join(baseDir, "team+agent-123");
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: `worktree ${expectedPath}\nHEAD abcdef\nbranch refs/heads/worktree-team+agent-123\n\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const manager = createChildAgentWorktreeManager({
      cwd: "/repo",
      configDir: "/config",
      runGit,
    });

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
      const baseDir = computeChildAgentWorktreeBaseDir(
        "C:\\Repo",
        "C:\\Config",
      );
      const expectedPath = join(baseDir, "team+agent-123");
      const listedPath = expectedPath.replace(/\\/g, "/").toUpperCase();
      const runGit = vi.fn(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: `worktree ${listedPath}\nbranch refs/heads/worktree-team+agent-123\n\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const manager = createChildAgentWorktreeManager({
        cwd: "C:\\Repo",
        configDir: "C:\\Config",
        runGit,
      });

      expect((await manager.create("team/agent-123")).created).toBe(false);
      expect(runGit).not.toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add"]),
        expect.any(String),
      );
    },
  );
});

const realRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CEILING_DIRECTORIES: dirname(cwd),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) =>
      resolve({ code: 127, stdout, stderr: error.message }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

describe("default child environment worktree release", () => {
  let tmpRoot: string;
  let repoRoot: string;
  let worktreePath: string | undefined;

  beforeEach(async () => {
    worktreePath = undefined;
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
    if (worktreePath)
      await realRunGit(
        ["worktree", "remove", "--force", worktreePath],
        repoRoot,
      );
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("retains even a clean newly-created isolated worktree by default", async () => {
    const lease = await createDefaultChildEnvironmentProvider().acquire(
      {
        description: "test child",
        prompt: "test",
        agent: "worker",
        team: "team",
        cwd: repoRoot,
        isolate: true,
      },
      "child-1",
    );
    worktreePath = lease.worktree?.path;

    expect(lease.worktree).toBeDefined();
    await lease.release({ status: "completed", output: "" });

    const listed = await realRunGit(
      ["worktree", "list", "--porcelain"],
      repoRoot,
    );
    expect(listed.stdout.replace(/\\/g, "/")).toContain(
      lease.cwd.replace(/\\/g, "/"),
    );
  });

  it("removes an unchanged directory only when automatic cleanup is explicitly enabled", async () => {
    const lease = await createDefaultChildEnvironmentProvider({
      autoCleanup: true,
    }).acquire(
      {
        description: "test",
        prompt: "test",
        agent: "worker",
        cwd: repoRoot,
        isolate: true,
      },
      "child",
    );
    worktreePath = lease.worktree?.path;
    await lease.release({ status: "completed", output: "" });
    expect(
      (
        await realRunGit(["worktree", "list", "--porcelain"], repoRoot)
      ).stdout.replace(/\\/g, "/"),
    ).not.toContain(lease.cwd.replace(/\\/g, "/"));
    expect(
      (
        await realRunGit(
          ["show-ref", `refs/heads/${lease.worktree!.branch}`],
          repoRoot,
        )
      ).code,
    ).toBe(0);
  });

  it("retains committed but unmerged results even with automatic cleanup enabled", async () => {
    const lease = await createDefaultChildEnvironmentProvider({
      autoCleanup: true,
    }).acquire(
      {
        description: "test",
        prompt: "test",
        agent: "worker",
        cwd: repoRoot,
        isolate: true,
      },
      "child",
    );
    worktreePath = lease.worktree?.path;
    await writeFile(join(lease.cwd, "result.txt"), "committed result\n");
    await realRunGit(["add", "."], lease.cwd);
    await realRunGit(["commit", "-m", "child result"], lease.cwd);
    await lease.release({ status: "completed", output: "" });
    expect(
      (
        await realRunGit(["worktree", "list", "--porcelain"], repoRoot)
      ).stdout.replace(/\\/g, "/"),
    ).toContain(lease.cwd.replace(/\\/g, "/"));
  });

  it("cleans merged results and keeps the result branch", async () => {
    const lease = await createDefaultChildEnvironmentProvider({
      autoCleanup: true,
    }).acquire(
      {
        description: "test",
        prompt: "test",
        agent: "worker",
        cwd: repoRoot,
        isolate: true,
      },
      "child",
    );
    worktreePath = lease.worktree?.path;
    await writeFile(join(lease.cwd, "result.txt"), "merged result\n");
    await realRunGit(["add", "."], lease.cwd);
    await realRunGit(["commit", "-m", "child result"], lease.cwd);
    await realRunGit(["merge", "--ff-only", lease.worktree!.branch], repoRoot);
    await lease.release({ status: "completed", output: "" });
    expect(
      (
        await realRunGit(["worktree", "list", "--porcelain"], repoRoot)
      ).stdout.replace(/\\/g, "/"),
    ).not.toContain(lease.cwd.replace(/\\/g, "/"));
    expect(
      (
        await realRunGit(
          ["show-ref", `refs/heads/${lease.worktree!.branch}`],
          repoRoot,
        )
      ).code,
    ).toBe(0);
  });

  it("allows explicit disposal of committed results without deleting the branch", async () => {
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: realRunGit,
    });
    const created = await manager.create("disposable");
    worktreePath = created.path;
    await writeFile(join(created.path, "result.txt"), "retained on branch\n");
    await realRunGit(["add", "."], created.path);
    await realRunGit(["commit", "-m", "child result"], created.path);
    await expect(manager.remove("disposable")).rejects.toThrow("unmerged");
    await manager.remove("disposable", { discardUnmerged: true });
    expect(
      (await realRunGit(["show-ref", `refs/heads/${created.branch}`], repoRoot))
        .code,
    ).toBe(0);
  });

  it("rejects explicit isolation for a non-Git directory instead of running in it", async () => {
    const plain = join(tmpRoot, "plain");
    await mkdir(plain);
    await expect(
      createDefaultChildEnvironmentProvider().acquire(
        {
          description: "test",
          prompt: "test",
          agent: "worker",
          cwd: plain,
          isolate: true,
        },
        "child",
      ),
    ).rejects.toThrow("cannot fall back");
  });

  it("does not reset an existing branch when its generated branch name conflicts", async () => {
    await realRunGit(["switch", "-c", "worktree-collision"], repoRoot);
    await writeFile(join(repoRoot, "result.txt"), "existing branch result\n");
    await realRunGit(["add", "."], repoRoot);
    await realRunGit(["commit", "-m", "existing result"], repoRoot);
    const original = (
      await realRunGit(["rev-parse", "HEAD"], repoRoot)
    ).stdout.trim();
    await realRunGit(["switch", "main"], repoRoot);
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: realRunGit,
    });
    const created = await manager.create("collision");
    worktreePath = created.path;
    expect(created.branch).toBe("worktree-collision-2");
    expect(
      (
        await realRunGit(["rev-parse", "worktree-collision"], repoRoot)
      ).stdout.trim(),
    ).toBe(original);
  });

  it("accepts a host branch prefix without changing existing branches", async () => {
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      branchPrefix: "host/",
      runGit: realRunGit,
    });
    const created = await manager.create("prefixed");
    worktreePath = created.path;
    expect(created.branch).toBe("host/prefixed");
    expect(
      (await realRunGit(["show-ref", "refs/heads/host/prefixed"], repoRoot))
        .code,
    ).toBe(0);
  });

  it("does not overwrite a branch created concurrently after branch inspection", async () => {
    await realRunGit(["switch", "-c", "protected-result"], repoRoot);
    await writeFile(join(repoRoot, "result.txt"), "concurrent branch result\n");
    await realRunGit(["add", "."], repoRoot);
    await realRunGit(["commit", "-m", "protected result"], repoRoot);
    const protectedCommit = (
      await realRunGit(["rev-parse", "HEAD"], repoRoot)
    ).stdout.trim();
    await realRunGit(["switch", "main"], repoRoot);
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: async (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "add")
          await realRunGit(["branch", args[3]!, protectedCommit], repoRoot);
        return realRunGit(args, cwd);
      },
    });
    await expect(manager.create("raced")).rejects.toThrow(
      "worktree add failed",
    );
    expect(
      (
        await realRunGit(["rev-parse", "worktree-raced"], repoRoot)
      ).stdout.trim(),
    ).toBe(protectedCommit);
  });

  it("protects a worktree created by another owner", async () => {
    const path = join(
      computeChildAgentWorktreeBaseDir(repoRoot, runtimePaths.configDir),
      "foreign",
    );
    await realRunGit(
      ["worktree", "add", "-b", "user-branch", path, "HEAD"],
      repoRoot,
    );
    worktreePath = path;
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: realRunGit,
    });
    await expect(manager.remove("foreign")).rejects.toThrow();
    expect(
      (
        await realRunGit(["worktree", "list", "--porcelain"], repoRoot)
      ).stdout.replace(/\\/g, "/"),
    ).toContain(path.replace(/\\/g, "/"));
  });

  it("treats a failed status check as unverified instead of clean", async () => {
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: async (args, cwd) =>
        args[0] === "status"
          ? { code: 1, stdout: "", stderr: "status unavailable" }
          : realRunGit(args, cwd),
    });
    const created = await manager.create("status-failure");
    worktreePath = created.path;
    await expect(manager.hasChanges("status-failure")).rejects.toThrow();
    await expect(manager.remove("status-failure")).rejects.toThrow();
  });

  it("refuses force removal of a dirty worktree", async () => {
    const manager = createChildAgentWorktreeManager({
      cwd: repoRoot,
      configDir: runtimePaths.configDir,
      runGit: realRunGit,
    });
    const created = await manager.create("dirty");
    worktreePath = created.path;
    await writeFile(join(created.path, "uncommitted.txt"), "retain this\n");
    await expect(manager.remove("dirty", { force: true })).rejects.toThrow();
    expect(
      (
        await realRunGit(["worktree", "list", "--porcelain"], repoRoot)
      ).stdout.replace(/\\/g, "/"),
    ).toContain(created.path.replace(/\\/g, "/"));
  });

  it("retains a dirty newly-created isolated worktree on release", async () => {
    const lease = await createDefaultChildEnvironmentProvider({
      autoCleanup: true,
    }).acquire(
      {
        description: "test child",
        prompt: "test",
        agent: "worker",
        team: "team",
        cwd: repoRoot,
        isolate: true,
      },
      "child-1",
    );
    worktreePath = lease.worktree?.path;
    await writeFile(join(lease.cwd, "dirty.txt"), "uncommitted\n");

    await lease.release({ status: "completed", output: "" });

    const listed = await realRunGit(
      ["worktree", "list", "--porcelain"],
      repoRoot,
    );
    expect(listed.stdout.replace(/\\/g, "/")).toContain(
      lease.cwd.replace(/\\/g, "/"),
    );
  });
});
