import type { GitService } from "../../settings-api.js";

export function createDefaultGitService(): GitService {
  return {
    async diff({ cwd, full }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        if (full) {
          const { stdout } = await execAsync("git", ["diff", "HEAD"], {
            cwd,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          return { output: stdout || "(no diff)" };
        }
        const { stdout } = await execAsync("git", ["diff", "--stat"], { cwd, windowsHide: true });
        return { output: stdout || "(no changes)" };
      } catch (error) {
        throw new Error(`git diff failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async branch({ cwd, list }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        if (list) {
          const { stdout } = await execAsync("git", ["branch", "-a"], { cwd, windowsHide: true });
          return { output: stdout || "(no branches)" };
        }
        const { stdout } = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          windowsHide: true,
        });
        return { output: `Current branch: ${stdout.trim()}` };
      } catch (error) {
        throw new Error(`git branch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async status({ cwd }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        const { stdout } = await execAsync("git", ["status", "--short"], { cwd, windowsHide: true });
        return { output: stdout || "(working tree clean)" };
      } catch (error) {
        throw new Error(`git status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async commit({ cwd, message }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        await execAsync("git", ["add", "-A"], { cwd, windowsHide: true });
        const { stdout } = await execAsync("git", ["commit", "-m", message], { cwd, windowsHide: true });
        return { output: stdout.trim() || "Committed." };
      } catch (error) {
        throw new Error(`git commit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
