import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cwd: string; config: any; child: any }>);
vi.mock("./availability.js", () => ({ getSrtAvailability: () => ({ available: true }) }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: (_bin: string, args: string[], options: { cwd: string }) => {
    const child = new EventEmitter();
    spawned.push({ cwd: options.cwd, config: JSON.parse(readFileSync(args[1]!, "utf8")), child });
    return child;
  },
}));
import { createProcess, createShellProcess } from "./shell.js";

describe("sandbox process working directory", () => {
  it.each(["argv", "shell"])("bases relative filesystem rules on the workspace while running %s in a subdirectory", async (form) => {
    const workspaceRoot = process.cwd();
    const cwd = join(workspaceRoot, "src");
    const options = { cwd, workspaceRoot, settings: { model: "test", sandbox: { enabled: true,
      filesystem: { allowRead: ["."], denyRead: ["private"], allowWrite: ["."], denyWrite: ["secret"], extraAllowedRoots: ["shared"] } } } as any,
      shellDescriptor: { family: "cmd", dialect: "cmd", executable: "cmd.exe", argsPrefix: ["/d", "/s", "/c"],
        displayName: "cmd", pathStyle: "windows", tempDir: "C:\\Temp", capabilities: { conditionalAndOr: true, supportsLoginShell: false } } as const };
    if (form === "argv") await createProcess(["node", "script"], options);
    else await createShellProcess("echo ok", options);
    const actual = spawned.at(-1)!;
    try {
      expect(actual.cwd).toBe(cwd);
      expect(actual.config.filesystem).toEqual({ allowRead: [workspaceRoot, join(workspaceRoot, "shared")], denyRead: [join(workspaceRoot, "private")],
        allowWrite: [workspaceRoot, join(workspaceRoot, "shared")], denyWrite: [join(workspaceRoot, "secret")] });
    } finally { actual.child.emit("close", 0); }
  });
});
