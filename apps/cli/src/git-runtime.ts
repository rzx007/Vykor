import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { resolveGitRepository } from "@vykor/core";

interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function computeWorktreeBaseDir(repoRoot: string, configDir: string): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const repoId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(configDir, "worktrees", repoId);
}

export const nodeRunGit: GitRunner = (args, cwd) =>
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
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export async function resolveRepoRoot(cwd: string): Promise<string> {
  return resolveGitRepository(cwd)?.root ?? cwd;
}
