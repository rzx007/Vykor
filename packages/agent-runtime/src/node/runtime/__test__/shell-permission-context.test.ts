import { describe, expect, it } from "vitest";
import type { ExecutionEnvironmentHandle, ShellDescriptor } from "@vykor/environment";
import { createVykorRuntime } from "../default-runtime.js";
import { resolveHostShellLauncher } from "@vykor/sandbox";

function environment(family: ShellDescriptor["family"]): ExecutionEnvironmentHandle {
  const descriptor: ShellDescriptor = {
    family, dialect: family === "posix" ? "posix-sh" : family === "powershell" ? "pwsh" : "cmd",
    executable: family === "posix" ? "/bin/sh" : `${family}.exe`, argsPrefix: [], displayName: family,
    pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: false },
  };
  return {
    info: {
      kind: "wsl", hostOs: "Windows", executionOs: "Linux", shell: descriptor.executable,
      // The actual Shell executor uses shellDescriptor, not this legacy label.
      shellDialect: "cmd", shellDescriptor: descriptor, pathStyle: "posix", cwd: "/workspace",
      homeDir: "/home", tempDir: "/tmp", mounts: [{ path: "/workspace", mode: "rw", purpose: "workspace" }],
      networkMode: "bridge", limitations: [],
    },
    workspace: { kind: "wsl", hostRoot: process.cwd(), executionRoot: "/workspace" },
    process: {} as never, files: {} as never, paths: {} as never,
    release: async () => {},
  };
}

describe("runtime Shell permission context", () => {
  it.each([
    ["ask", "execute", "ask"],
    ["auto_review", "execute", "ask"],
    ["full_access", "execute", "allow"],
    ["full_access", "plan", "deny"],
  ] as const)("applies session approval %s and work mode %s to PowerShell scripts", async (approvalMode, workMode, action) => {
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission: { mode: "ask" } },
      configuration: {
        approvalMode, workMode,
        client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
      },
      executionEnvironment: environment("powershell"),
    });
    try {
      await expect(runtime.permissionChecker.checkTool("Shell", {
        command: "$ErrorActionPreference='SilentlyContinue'; node -v; npx -v; Get-Command python | Select-Object Source",
      })).resolves.toMatchObject({ action });
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(resolveHostShellLauncher().kind === "cmd")("uses the same cached host launcher as the default Shell executor", async () => {
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission: { mode: "full_auto" } },
      configuration: { client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } } },
    });
    try {
      await expect(runtime.permissionChecker.checkTool("Shell", { command: "echo 'literal;SECOND'; git status" }))
        .resolves.toMatchObject({ action: "allow" });
    } finally {
      await runtime.close();
    }
  });

  it.each(["posix", "powershell"] as const)("uses the actual %s executor descriptor for compound command permissions", async family => {
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission: { mode: "full_auto", deniedCommands: ["rm -rf*"] } },
      configuration: { client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } } },
      executionEnvironment: environment(family),
    });
    try {
      await expect(runtime.permissionChecker.checkTool("Shell", {
        command: "git status; echo SECOND", shellDialect: "cmd",
      })).resolves.toMatchObject({ action: "allow" });
      await expect(runtime.permissionChecker.checkTool("Shell", {
        command: "echo harmless; rm -rf ./dummy", shellDialect: "cmd",
      })).resolves.toMatchObject({ action: "deny" });
    } finally {
      await runtime.close();
    }
  });
});
