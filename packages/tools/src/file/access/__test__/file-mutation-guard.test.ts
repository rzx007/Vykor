import { describe, expect, it } from "vitest";
import { isSystemPath } from "../file-mutation-guard.js";

describe("system path shape guard", () => {
  it.each([
    String.raw`\\?\C:\Windows\blocked.txt`,
    String.raw`C:\safe\..\WINDOWS\blocked.txt`,
    String.raw`\\?\c:\safe\..\Program Files\blocked.txt`,
    "C:/safe/../Program Files (x86)/blocked.txt",
    "/safe/../etc/blocked.txt",
    "/usr/local/../bin/blocked.txt",
    "/etc",
    "C:/Windows",
  ])("recognizes protected directories after normalization: %s", path => {
    expect(isSystemPath(path)).toBe(true);
  });

  it.each(["C:/Windows-user/ok.txt", "C:/Windows/../workspace/ok.txt", "/etc/../workspace/ok.txt", "/etc-user/ok.txt"])
    ("does not protect paths outside those directory boundaries: %s", path => {
      expect(isSystemPath(path)).toBe(false);
    });
});
