import { describe, expect, it } from "vitest";
import { PermissionChecker } from "./index.js";

describe("permission rules match the resolved path target", () => {
  it.each(["/work/private/a.txt", "/work/public/../private/a.txt", "public/../private/a.txt"])
    ("denies equivalent POSIX targets before raw public spelling can allow them: %s", async file_path => {
      const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", autoApproveTools: ["Write"],
        pathRules: [{ pattern: "/work/public/*", allow: true }, { pattern: "/work/private/*", allow: false }] });
      await expect(checker.checkTool("Write", { file_path })).resolves.toMatchObject({ action: "deny" });
    });

  it.each([
    String.raw`C:\work\public\..\private\a.txt`,
    "C:/work/public/../private/a.txt",
    String.raw`\\?\C:\work\public\..\PRIVATE\a.txt`,
    String.raw`public\..\private\a.txt`,
  ])("uses Windows separators, drive extension and case for the same target: %s", async file_path => {
    const checker = new PermissionChecker({ mode: "default", cwd: String.raw`C:\work`, pathStyle: "windows", autoApproveTools: ["Write"],
      pathRules: [{ pattern: "C:/work/public/*", allow: true }, { pattern: "C:/work/private/*", allow: false }] });
    await expect(checker.checkTool("Write", { file_path })).resolves.toMatchObject({ action: "deny" });
  });

  it("interprets Windows rule separators and extension prefixes in the same namespace", async () => {
    const checker = new PermissionChecker({ mode: "default", cwd: String.raw`C:\work`, pathStyle: "windows", autoApproveTools: ["Write"],
      pathRules: [{ pattern: String.raw`\\?\C:\work\private\*`, allow: false }] });
    await expect(checker.checkTool("Write", { file_path: "c:/work/private/a.txt" })).resolves.toMatchObject({ action: "deny" });
  });

  it.each(["/work/private/a.txt", "/work/public/../private/a.txt"])
    ("resolves directory rules against cwd: %s", async file_path => {
      const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", autoApproveTools: ["Write"],
        pathRules: [{ pattern: "public/*", allow: true }, { pattern: "private/*", allow: false }] });
      await expect(checker.checkTool("Write", { file_path })).resolves.toMatchObject({ action: "deny" });
    });

  it("preserves full-path wildcard rules including targets outside cwd", async () => {
    const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", autoApproveTools: ["Write"],
      pathRules: [{ pattern: "*.env", allow: false }] });
    await expect(checker.checkTool("Write", { file_path: "/outside/nested/config.env" })).resolves.toMatchObject({ action: "deny" });
    await expect(checker.checkTool("Write", { file_path: "public/../private/config.env" })).resolves.toMatchObject({ action: "deny" });
  });

  it("keeps literal URI-shaped paths in their original namespace", async () => {
    const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", autoApproveTools: ["BusinessTool"],
      pathRules: [{ pattern: "resource://zone/public/../private/*", allow: false }] });
    await expect(checker.checkTool("BusinessTool", { path: "resource://zone/public/../private/a.txt" })).resolves.toMatchObject({ action: "deny" });
    await expect(checker.checkTool("BusinessTool", { path: "resource://zone/private/a.txt" })).resolves.toMatchObject({ action: "allow" });
  });

  it("keeps the first rule decision on a normalized target", async () => {
    const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix",
      pathRules: [{ pattern: "/work/*", allow: true }, { pattern: "/work/private/*", allow: false }] });
    await expect(checker.checkTool("Write", { file_path: "public/../private/a.txt" })).resolves.toMatchObject({ action: "allow" });
  });

  it("normalizes ordered path patterns while leaving command patterns untouched", async () => {
    const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", rules: [
      { tool: "BusinessTool", pathPattern: "private/*", action: "deny" },
      { tool: "BusinessTool", action: "allow" },
      { tool: "Shell", commandPattern: "run public/../private/*", action: "deny" },
      { tool: "Shell", action: "allow" },
    ] });
    await expect(checker.checkTool("BusinessTool", { path: "public/../private/a.txt" })).resolves.toMatchObject({ action: "deny" });
    await expect(checker.checkTool("Shell", { command: "run public/../private/a.txt" })).resolves.toMatchObject({ action: "deny" });
    await expect(checker.checkTool("Shell", { command: "run private/a.txt" })).resolves.toMatchObject({ action: "allow" });
  });
});
