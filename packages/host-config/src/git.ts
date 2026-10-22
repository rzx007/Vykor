import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitRepositoryInfo {
  root: string;
  gitDir: string;
  branch?: string;
}

function readGitDir(marker: string, root: string): string | undefined {
  try {
    if (statSync(marker).isDirectory()) return marker;
    const match = readFileSync(marker, "utf-8").trim().match(/^gitdir:\s*(.+)$/i);
    if (!match?.[1]) return undefined;
    return isAbsolute(match[1]) ? resolve(match[1]) : resolve(root, match[1]);
  } catch {
    return undefined;
  }
}

function readBranch(gitDir: string): string | undefined {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    const prefix = "ref: refs/heads/";
    return head.startsWith(prefix) ? head.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

/** Find the containing Git repository without spawning Git or a shell. */
export function resolveGitRepository(cwd: string): GitRepositoryInfo | undefined {
  let current = resolve(cwd);
  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      const gitDir = readGitDir(marker, current);
      if (gitDir) return { root: current, gitDir, branch: readBranch(gitDir) };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
