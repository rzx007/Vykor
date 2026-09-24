import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitRepository } from "./git";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveGitRepository", () => {
  it("finds a parent repository and branch without invoking Git", () => {
    const root = mkdtempSync(join(tmpdir(), "vykor-git-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feature/no-flash\n");
    const nested = join(root, "packages", "core");
    mkdirSync(nested, { recursive: true });

    expect(resolveGitRepository(nested)).toEqual({
      root,
      gitDir: join(root, ".git"),
      branch: "feature/no-flash",
    });
  });

  it("resolves a worktree gitdir file", () => {
    const parent = mkdtempSync(join(tmpdir(), "vykor-worktree-"));
    roots.push(parent);
    const root = join(parent, "checkout");
    const gitDir = join(parent, "metadata");
    mkdirSync(root);
    mkdirSync(gitDir);
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/worktree\n");

    expect(resolveGitRepository(root)).toEqual({ root, gitDir, branch: "worktree" });
  });
});
