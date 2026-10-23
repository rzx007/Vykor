import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function defaultCommand(cwd: string): Promise<string[]> {
  try {
    const require = createRequire(resolve(cwd, "package.json"));
    const manifestPath = require.resolve("@rzx/ohs/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vk;
    if (typeof bin !== "string") throw new Error("CLI bin is missing");
    return [process.execPath, resolve(dirname(manifestPath), bin), "serve", "--register", "--host", "127.0.0.1", "--port", "0"];
  } catch {
    throw new Error("Cannot locate Vykor CLI. Install @rzx/ohs in your application or pass Service.ensure({ command: [executable, ...args] }).");
  }
}

export function startProcess(command: readonly string[], cwd: string, env: Record<string, string | undefined>): {
  child: ChildProcess;
  failure: () => Error | undefined;
} {
  if (!command[0]?.trim()) throw new Error("Service command must include an executable.");
  const child = spawn(command[0], command.slice(1), {
    cwd, env, stdio: "ignore", detached: true, windowsHide: true, shell: false,
  });
  let failure: Error | undefined;
  child.once("error", () => { failure = new Error("Cannot spawn Vykor service executable."); });
  child.once("exit", (code, signal) => {
    failure ??= new Error(`Vykor service exited before registration (${signal ?? code}).`);
  });
  child.unref();
  return { child, failure: () => failure };
}

/** Releases only the child started by this startup attempt. */
export async function abandonProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 500);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
