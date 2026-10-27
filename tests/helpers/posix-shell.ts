import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** Find a real POSIX shell for tests that execute fixed WSL scripts locally. */
export function findPosixShell(): string | undefined {
  const candidates = process.platform === "win32" ? ["sh.exe"] : ["/bin/sh"];
  if (process.platform === "win32") {
    const git = spawnSync("git", ["--exec-path"], {
      encoding: "utf8", windowsHide: true, timeout: 3000,
    });
    if (git.status === 0 && git.stdout.trim()) {
      candidates.push(resolve(git.stdout.trim(), "../../..", "bin/sh.exe"));
    }
    candidates.push(join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/sh.exe"));
  }
  return candidates.find((candidate) => spawnSync(candidate, ["-c", "exit 0"], {
    stdio: "ignore", windowsHide: true, timeout: 3000,
  }).status === 0);
}
