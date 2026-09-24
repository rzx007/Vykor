import { describe, expect, it } from "vitest";
import { shellArgv, type ShellDescriptor } from "./shell-descriptor.js";

describe("ShellDescriptor", () => {
  it("keeps executable and launch arguments separate", () => {
    const shell: ShellDescriptor = {
      family: "powershell",
      dialect: "windows-powershell",
      executable: "powershell.exe",
      argsPrefix: ["-NoLogo", "-NoProfile", "-Command"],
      displayName: "Windows PowerShell 5.1",
      version: "5.1",
      pathStyle: "windows",
      tempDir: "C:\\Temp",
      capabilities: { conditionalAndOr: false, supportsLoginShell: false },
    };

    const argv = shellArgv(shell, "Get-Location");
    expect(argv.slice(0, 4)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]);
    expect(argv.at(-1)).toContain("Get-Location");
  });

  it("initializes UTF-8 before a Windows PowerShell command", () => {
    const shell: ShellDescriptor = {
      family: "powershell", dialect: "windows-powershell", executable: "powershell.exe",
      argsPrefix: ["-NoLogo", "-NoProfile", "-Command"], displayName: "Windows PowerShell 5.1",
      pathStyle: "windows", tempDir: "C:\\Temp",
      capabilities: { conditionalAndOr: false, supportsLoginShell: false },
    };
    expect(shellArgv(shell, "Write-Output '中文'").at(-1)).toContain("OutputEncoding");
    expect(shellArgv(shell, "Write-Output '中文'").at(-1)).toContain("Write-Output '中文'");
  });
});

import { createWorkspaceBinding } from "./types.js";

describe("createWorkspaceBinding", () => {
  it("keeps host and execution roots separate for WSL", () => {
    expect(createWorkspaceBinding({
      kind: "wsl",
      hostRoot: "D:\\code\\vk",
      executionRoot: "/mnt/d/code/vk",
    })).toEqual({
      kind: "wsl",
      hostRoot: "D:\\code\\vk",
      executionRoot: "/mnt/d/code/vk",
    });
  });

  it("rejects a non-POSIX WSL execution root", () => {
    expect(() => createWorkspaceBinding({
      kind: "wsl",
      hostRoot: "D:\\code\\vk",
      executionRoot: "D:\\code\\vk",
    })).toThrow("WSL execution root must be an absolute POSIX path");
  });

  it("requires local roots to refer to the same directory", () => {
    expect(() =>
      createWorkspaceBinding({
        kind: "local",
        hostRoot: "D:\\code\\vk",
        executionRoot: "/workspace",
      }),
    ).toThrow("Local workspace roots must match");
  });
});
