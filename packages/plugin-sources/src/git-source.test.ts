import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { resolveGitPluginSource, type GitRunner } from "./git-source.js";

const created: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(created.splice(0).map((cleanup) => cleanup()));
});

function runnerWithHead(commit = "a".repeat(40)): GitRunner {
  return async (args, options) => {
    if (args.includes("checkout")) {
      await mkdir(join(options.cwd, ".vykor-plugin"), { recursive: true });
      await mkdir(join(options.cwd, ".git"), { recursive: true });
      await writeFile(join(options.cwd, ".vykor-plugin", "plugin.json"), JSON.stringify({
        schemaVersion: 1,
        id: "dev.example.git",
        name: "Git Plugin",
        version: "1.0.0",
        components: {},
      }));
      await writeFile(join(options.cwd, ".git", "config"), "[remote \"origin\"]");
    }
    return args.includes("rev-parse") ? { stdout: `${commit}\n`, stderr: "" } : { stdout: "", stderr: "" };
  };
}

it("resolves a git plugin source by fetching a ref and removing git metadata", async () => {
  const resolved = await resolveGitPluginSource({
    url: "https://example.com/acme/plugin.git",
    ref: "v1.0.0",
    runGit: runnerWithHead(),
  });
  created.push(resolved.cleanup);

  expect(resolved.commit).toBe("a".repeat(40));
  expect(resolved.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(join(resolved.candidateRoot, ".vykor-plugin", "plugin.json"), "utf8"))
    .toContain("dev.example.git");
  await expect(stat(join(resolved.candidateRoot, ".git"))).rejects.toThrow();
});

it("uses HEAD when no ref is provided", async () => {
  const calls: string[][] = [];
  const resolved = await resolveGitPluginSource({
    url: "ssh://git@example.com/acme/plugin.git",
    runGit: async (args, options) => {
      calls.push(args);
      return runnerWithHead("b".repeat(40))(args, options);
    },
  });
  created.push(resolved.cleanup);

  expect(calls.some((args) => args.includes("fetch") && args.at(-1) === "HEAD")).toBe(true);
});

it("rejects unsafe git source values before invoking git", async () => {
  const runGit = vi.fn<GitRunner>();

  await expect(resolveGitPluginSource({
    url: "-c core.sshCommand=bad",
    runGit,
  })).rejects.toThrow(/invalid git source url/i);
  await expect(resolveGitPluginSource({
    url: "https://example.com/acme/plugin.git",
    ref: "-bad",
    runGit,
  })).rejects.toThrow(/invalid git ref/i);
  expect(runGit).not.toHaveBeenCalled();
});

it("cleans the temporary clone when git fails", async () => {
  let cloneRoot = "";
  await expect(resolveGitPluginSource({
    url: "https://example.com/acme/plugin.git",
    runGit: async (_args, options) => {
      cloneRoot = options.cwd;
      throw new Error("git failed");
    },
  })).rejects.toThrow(/git failed/i);

  await expect(stat(cloneRoot)).rejects.toThrow();
});
