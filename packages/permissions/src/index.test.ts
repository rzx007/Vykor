import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PermissionChecker,
  LOCAL_READ_ONLY_TOOLS,
  READ_ONLY_TOOLS,
} from "../src/index.js";
import type { PermissionCheckOptions } from "../src/index.js";

async function withTempCwd(
  fn: (cwd: string) => Promise<void> | void,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "vk-permissions-"));
  try {
    await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("PermissionChecker", () => {
  it("treats POSIX cwd paths in the execution namespace", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      cwd: "/workspace",
      pathStyle: "posix",
    });

    await expect(
      checker.checkTool("Read", { file_path: "/workspace/src/app.ts" }),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      checker.checkTool("Read", { file_path: "/etc/passwd" }),
    ).resolves.toMatchObject({ action: "ask" });
  });

  it("rejects Windows absolute path rules in a POSIX environment", () => {
    expect(() => new PermissionChecker({
      mode: "default",
      cwd: "/workspace",
      pathStyle: "posix",
      pathRules: [{ pattern: "D:\\code\\*", allow: true }],
    })).toThrow("invalid_execution_path_rule");
  });

  it("allows all tools in full_auto mode", async () => {
    const checker = new PermissionChecker({
      mode: "full_auto",
      rules: [],
    });
    const result = await checker.checkTool("bash", { command: "rm -rf /" });
    expect(result.action).toBe("allow");
  });

  it("asks in default mode with no rules", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [],
    });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("ask");
  });

  it("asks in plan mode", async () => {
    const checker = new PermissionChecker({
      mode: "plan",
      rules: [],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("ask");
  });

  it("allows tool matching an allow rule", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "read_file", action: "allow" }],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("allow");
  });

  it("denies tool matching a deny rule", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("deny");
  });

  it("skips rule when tool name does not match", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("ask");
  });

  it("matches pathPattern with glob", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ pathPattern: "/safe/*", action: "allow" }],
    });
    const allow = await checker.checkTool("read_file", {
      path: "/safe/file.txt",
    });
    expect(allow.action).toBe("allow");
    const deny = await checker.checkTool("read_file", { path: "/etc/passwd" });
    expect(deny.action).toBe("ask");
  });

  it("matches commandPattern with glob", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ commandPattern: "git *", action: "allow" }],
    });
    const allow = await checker.checkTool("bash", { command: "git status" });
    expect(allow.action).toBe("allow");
    const deny = await checker.checkTool("bash", { command: "rm -rf /" });
    expect(deny.action).toBe("ask");
  });

  it("addRule adds new rule", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    checker.addRule({ tool: "bash", action: "deny" });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("deny");
  });

  it("removeRule removes rule by index", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    checker.removeRule(0);
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("ask");
  });

  it("getRules returns current rules", () => {
    const rules = [{ tool: "bash", action: "deny" as const }];
    const checker = new PermissionChecker({ mode: "default", rules });
    expect(checker.getRules()).toEqual(rules);
  });

  it("setMode changes mode", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    checker.setMode("full_auto");
    expect(checker.getMode()).toBe("full_auto");
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("allow");
  });
});

describe("autoApproveTools (swarm worker read-only auto-approval)", () => {
  it("allows an auto-approved tool in default mode", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Read", "Grep"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Tool 'Read' is auto-approved");
  });

  it("still asks for non-auto-approved tools in default mode", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Read", "Grep"],
    });
    const result = await checker.checkTool("Write", { path: "/foo" });
    expect(result.action).toBe("ask");
  });

  it("deniedTools takes priority over autoApprove (deny wins)", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      deniedTools: ["Read"],
      autoApproveTools: ["Read"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("deny");
  });

  it("full_auto still short-circuits before autoApprove", async () => {
    const checker = new PermissionChecker({
      mode: "full_auto",
      deniedTools: ["Read"],
      autoApproveTools: ["Read"],
    });
    // full_auto is checked first, so even a denied+auto-approved tool allows.
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Full auto mode");
  });

  it("autoApprove放行 even when an allowedTools whitelist is set (order correct)", async () => {
    // allowedTools whitelist does NOT contain Read, but autoApprove is checked
    // first and放行 it.
    const checker = new PermissionChecker({
      mode: "default",
      allowedTools: ["SomeOtherTool"],
      autoApproveTools: ["Read"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Tool 'Read' is auto-approved");
  });

  it("no autoApproveTools → behavior unchanged (default mode asks)", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("ask");
  });

  it("pathRules deny 优先于 autoApprove(.env 类路径保护不可被放行绕过)", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Read"],
      pathRules: [{ pattern: "*.env", allow: false }],
    });
    expect(
      (await checker.checkTool("Read", { path: "/app/.env" })).action,
    ).toBe("deny");
    expect(
      (await checker.checkTool("Read", { path: "/app/a.ts" })).action,
    ).toBe("allow");
  });

  it("migrates legacy Bash permission entries to Shell without weakening denied commands", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Bash"],
      deniedCommands: ["rm -rf*"],
    });
    expect(
      (await checker.checkTool("Shell", { command: "rm -rf /" })).action,
    ).toBe("deny");
    expect((await checker.checkTool("Shell", { command: "ls" })).action).toBe(
      "allow",
    );
  });

  it("pathRules allow 仍受 allowedTools 白名单收窄(原序语义保留)", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      allowedTools: ["Grep"],
      pathRules: [{ pattern: "/app/*", allow: true }],
    });
    expect(
      (await checker.checkTool("Read", { path: "/app/a.ts" })).action,
    ).toBe("deny");
    expect(
      (await checker.checkTool("Grep", { path: "/app/a.ts" })).action,
    ).toBe("allow");
  });
});

describe("local read-only cwd auto-approval", () => {
  it("does not auto-approve an untrusted replacement for a local read-only tool", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({
        mode: "default",
        cwd,
        untrustedToolNames: ["Read"],
      });

      expect(
        (await checker.checkTool("Read", { file_path: join(cwd, "src/a.ts") }))
          .action,
      ).toBe("ask");
    });
  });

  it("allows local read-only filesystem tools inside cwd in default mode", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({ mode: "default", cwd });

      expect(
        (await checker.checkTool("Read", { file_path: join(cwd, "src/a.ts") }))
          .action,
      ).toBe("allow");
      expect(
        (await checker.checkTool("Grep", { path: join(cwd, "src") })).action,
      ).toBe("allow");
      expect(
        (
          await checker.checkTool("Glob", {
            path: join(cwd, "src"),
            pattern: "**/*.ts",
          })
        ).action,
      ).toBe("allow");
      expect(
        (
          await checker.checkTool("Lsp", {
            filePath: join(cwd, "src/a.ts"),
            operation: "hover",
          })
        ).action,
      ).toBe("allow");
    });
  });

  it("treats omitted Grep/Glob/Lsp paths as cwd-scoped reads", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({ mode: "default", cwd });

      expect((await checker.checkTool("Grep", { pattern: "foo" })).action).toBe(
        "allow",
      );
      expect(
        (await checker.checkTool("Glob", { pattern: "**/*.ts" })).action,
      ).toBe("allow");
      expect(
        (
          await checker.checkTool("Lsp", {
            operation: "workspace_symbol",
            query: "foo",
          })
        ).action,
      ).toBe("allow");
    });
  });

  it("asks for local read-only filesystem tools outside cwd", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({ mode: "default", cwd });
      const outside = join(cwd, "..", "outside.txt");

      expect(
        (await checker.checkTool("Read", { file_path: outside })).action,
      ).toBe("ask");
      expect((await checker.checkTool("Grep", { path: outside })).action).toBe(
        "ask",
      );
    });
  });

  it("does not auto-approve network read-only tools", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({ mode: "default", cwd });

      expect(
        (await checker.checkTool("WebFetch", { url: "https://example.com" }))
          .action,
      ).toBe("ask");
      expect(
        (await checker.checkTool("WebSearch", { query: "vykor" })).action,
      ).toBe("ask");
    });
  });

  it("keeps deny, rules, and allowedTools ahead of cwd local read-only allow", async () => {
    await withTempCwd(async (cwd) => {
      const file = join(cwd, "src/a.ts");
      const deniedTool = new PermissionChecker({
        mode: "default",
        cwd,
        deniedTools: ["Read"],
      });
      const deniedRule = new PermissionChecker({
        mode: "default",
        cwd,
        rules: [{ tool: "Read", action: "deny" }],
      });
      const narrowed = new PermissionChecker({
        mode: "default",
        cwd,
        allowedTools: ["Write"],
      });

      expect(
        (await deniedTool.checkTool("Read", { file_path: file })).action,
      ).toBe("deny");
      expect(
        (await deniedRule.checkTool("Read", { file_path: file })).action,
      ).toBe("deny");
      expect(
        (await narrowed.checkTool("Read", { file_path: file })).action,
      ).toBe("deny");
    });
  });

  it("keeps pathRules deny ahead of cwd local read-only allow", async () => {
    await withTempCwd(async (cwd) => {
      const checker = new PermissionChecker({
        mode: "default",
        cwd,
        pathRules: [{ pattern: "*.env", allow: false }],
      });

      expect(
        (await checker.checkTool("Read", { file_path: join(cwd, ".env") }))
          .action,
      ).toBe("deny");
      expect(
        (await checker.checkTool("Read", { file_path: join(cwd, "a.ts") }))
          .action,
      ).toBe("allow");
    });
  });
});

describe("READ_ONLY_TOOLS", () => {
  it("contains common read-only tools", () => {
    for (const tool of [
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "JobList",
      "JobRead",
      "JobWait",
    ]) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
    }
  });

  it("does not contain write/execute tools", () => {
    for (const tool of [
      "Write",
      "Edit",
      "Bash",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskWait",
      "TerminalRead",
      "TerminalList",
    ]) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("LOCAL_READ_ONLY_TOOLS", () => {
  it("contains only local filesystem/code intelligence read tools", () => {
    for (const tool of ["Read", "Grep", "Glob", "Lsp"]) {
      expect(LOCAL_READ_ONLY_TOOLS.has(tool)).toBe(true);
    }
    for (const tool of ["WebFetch", "WebSearch", "Write", "Edit", "Bash"]) {
      expect(LOCAL_READ_ONLY_TOOLS.has(tool)).toBe(false);
    }
  });
});
