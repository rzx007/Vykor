import { describe, expect, it } from "vitest";
import { PermissionChecker, type PermissionCheckOptions } from "../index.js";

function checker(options: Partial<PermissionCheckOptions> = {}) {
  return new PermissionChecker({ mode: "default", shellDialect: "posix", ...options });
}

describe("Shell command permissions", () => {
  // A full-string glob must not grant permissions to a second command.
  it.each([";", "\n", "|", "&&", "||"])("requires permission for every command separated by %j", async separator => {
    const permissions = checker({ rules: [{ commandPattern: "git *", action: "allow" }] });
    expect((await permissions.checkTool("Shell", { command: `git status ${separator} echo SECOND` })).action).toBe("ask");
  });

  it("allows a compound command when each command has permission", async () => {
    const permissions = checker({ rules: [
      { commandPattern: "git *", action: "allow" },
      { commandPattern: "echo *", action: "allow" },
    ] });
    expect((await permissions.checkTool("Shell", { command: "git status; echo SECOND" })).action).toBe("allow");
  });

  // Flattening parsed words must not lend an exact allow to different argv.
  it.each([
    ['"git status"', "git status"],
    ['"git status"; git status', "git status"],
    ['git "status --short"', "git status --short"],
  ])("keeps original word boundaries when matching an exact allowance: %s", async (command, commandPattern) => {
    const permissions = checker({ rules: [{ commandPattern, action: "allow" }] });
    expect((await permissions.checkTool("Shell", { command })).action).toBe("ask");
  });

  it.each(['"git status"', '"git status"; "git status"'])("allows a quoted executable only when its original spelling is authorized: %s", async command => {
    const permissions = checker({ rules: [{ commandPattern: '"git status"', action: "allow" }] });
    expect((await permissions.checkTool("Shell", { command })).action).toBe("allow");
  });

  it.each(["posix", "powershell"] as const)("denies a later command in full_auto using %s", async shellDialect => {
    const permissions = checker({ shellDialect, mode: "full_auto", deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("Shell", { command: "echo harmless; rm -rf ./dummy" })).action).toBe("deny");
  });

  it("keeps a later explicit deny ahead of an earlier ask or auto approval", async () => {
    const permissions = checker({ autoApproveTools: ["Shell"], rules: [
      { commandPattern: "echo *", action: "ask" },
      { commandPattern: "rm *", action: "deny" },
    ] });
    expect((await permissions.checkTool("Shell", { command: "echo harmless | rm ./dummy" })).action).toBe("deny");
  });

  it.each(["posix", "powershell"] as const)("keeps quoted semicolons literal in %s", async shellDialect => {
    const permissions = checker({ shellDialect, rules: [{ commandPattern: "echo *", action: "allow" }], deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("Shell", { command: "echo 'literal; rm -rf ./dummy'" })).action).toBe("allow");
  });

  it.each([
    ["posix", "echo $(rm -rf ./dummy)"],
    ["posix", "echo `rm -rf ./dummy`"],
    ["posix", "echo harmless > ./dummy"],
    ["posix", "echo harmless; cd /outside; git status"],
    ["posix", "echo 'unterminated"],
    ["posix", "echo harmless; (rm -rf ./dummy)"],
    ["posix", "echo harmless; bash -c 'rm -rf ./dummy'"],
    ["powershell", "echo $(Remove-Item ./dummy)"],
    ["powershell", 'echo "$(Remove-Item ./dummy)"'],
    ["powershell", "echo harmless; & $command"],
    ["powershell", "echo harmless; Set-Location ../outside; git status"],
    ["powershell", "echo --% literal"],
    ["powershell", "echo `literal"],
    ["powershell", "echo harmless # comment"],
    ["powershell", "echo harmless <# block #>"],
    ["powershell", "echo harmless\u00a0SECOND"],
    ["powershell", "echo harmless\u0085SECOND"],
    ["posix", "echo harmless\u200bSECOND"],
    ["cmd", "echo harmless & del dummy"],
  ] as const)("requires confirmation for unsupported %s syntax: %s", async (shellDialect, command) => {
    const permissions = checker({ shellDialect, mode: "full_auto", autoApproveTools: ["Shell"], rules: [{ action: "allow", commandPattern: "*" }] });
    expect((await permissions.checkTool("Shell", { command })).action).toBe("ask");
  });

  it("does not trust a model-supplied dialect", async () => {
    const permissions = checker({ shellDialect: "cmd", mode: "full_auto" });
    expect((await permissions.checkTool("Shell", { command: "echo harmless; rm -rf ./dummy", shellDialect: "posix" })).action).toBe("ask");
  });

  it("requires confirmation for compound syntax when the runtime provides no dialect", async () => {
    const permissions = new PermissionChecker({ mode: "full_auto" });
    expect((await permissions.checkTool("Shell", { command: "git status; echo SECOND", shellDialect: "posix" })).action).toBe("ask");
  });

  it("matches denied commands despite literal quoting and extra whitespace", async () => {
    const permissions = checker({ mode: "full_auto", deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("Shell", { command: "echo harmless; 'rm'  -rf ./dummy" })).action).toBe("deny");
  });

  it.each(["Shell", "BackgroundShellCreate", "TerminalOpen"])("keeps compound %s inputs behind command permissions", async tool => {
    const permissions = checker({ rules: [{ commandPattern: "git *", action: "allow" }] });
    expect((await permissions.checkTool(tool, { command: "git status; echo SECOND" })).action).toBe("ask");
  });

  it("checks BackgroundShellCreate suffixes with the same executor context", async () => {
    const permissions = checker({ mode: "full_auto", deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("BackgroundShellCreate", { command: "echo harmless; rm -rf ./dummy" })).action).toBe("deny");
  });

  it("does not lend the foreground interpreter identity to TerminalOpen", async () => {
    const permissions = checker({ mode: "full_auto" });
    expect((await permissions.checkTool("TerminalOpen", { command: "git status; echo SECOND", shell: "cmd.exe" })).action).toBe("ask");
    expect((await permissions.checkTool("TerminalOpen", { command: "git status", shell: "custom-shell" })).action).toBe("ask");
  });

  it.each([undefined, "cmd"] as const)("does not authorize indirect commands without a supported interpreter: %s", async shellDialect => {
    const permissions = checker({ shellDialect, mode: "full_auto", deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("Shell", { command: "exec rm -rf ./dummy" })).action).toBe("ask");
  });

  it.each([";", "\n", "|", "&&", "||"])("allows separately authorized commands joined by %j", async separator => {
    const permissions = checker({ rules: [{ commandPattern: "git *", action: "allow" }] });
    expect((await permissions.checkTool("Shell", { command: `git status ${separator} git diff` })).action).toBe("allow");
  });

  it("keeps doubled single quotes literal in PowerShell", async () => {
    const permissions = checker({ shellDialect: "powershell", rules: [{ commandPattern: "echo *", action: "allow" }], deniedCommands: ["rm -rf*"] });
    expect((await permissions.checkTool("Shell", { command: "echo 'it''s literal; rm -rf ./dummy'" })).action).toBe("allow");
  });

  it.each(["\r", "\r\n"])("applies explicit PowerShell deny rules after %j", async newline => {
    const permissions = checker({ shellDialect: "powershell", rules: [
      { commandPattern: "echo *", action: "allow" },
      { commandPattern: "Remove-Item *", action: "deny" },
    ] });
    expect((await permissions.checkTool("Shell", { command: `echo harmless${newline}Remove-Item ./dummy` })).action).toBe("deny");
  });

  it.each(["\r", "\r\n"])("applies deniedCommands after PowerShell %j in full_auto", async newline => {
    const permissions = checker({ shellDialect: "powershell", mode: "full_auto", deniedCommands: ["Remove-Item *"] });
    expect((await permissions.checkTool("Shell", { command: `echo harmless${newline}Remove-Item ./dummy` })).action).toBe("deny");
  });

  it.each([undefined, "posix", "cmd"] as const)("does not normalize a carriage return into an exact command allowance: %s", async shellDialect => {
    const permissions = checker({ shellDialect, rules: [{ commandPattern: "git", action: "allow" }] });
    expect((await permissions.checkTool("Shell", { command: "git\r" })).action).toBe("ask");
  });

  it.each(["command", "builtin", "nohup"])("requires confirmation before indirect execution through %s", async wrapper => {
    for (const shellDialect of [undefined, "posix", "cmd"] as const) {
      const permissions = checker({ shellDialect, mode: "full_auto", deniedCommands: ["rm -rf*"] });
      expect((await permissions.checkTool("Shell", { command: `${wrapper} rm -rf ./dummy` })).action).toBe("ask");
    }
  });
});
