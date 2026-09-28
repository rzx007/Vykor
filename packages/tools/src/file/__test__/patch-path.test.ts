import { describe, expect, it } from "vitest";
import { normalizePatchPath, patchPathIdentity } from "../patch-path.js";

describe("normalizePatchPath", () => {
  it("strips one standard a/ or b/ prefix", () => {
    expect(normalizePatchPath("a/src/app.ts", "posix")).toBe("src/app.ts");
    expect(normalizePatchPath("b/src/app.ts", "posix")).toBe("src/app.ts");
    expect(normalizePatchPath("src/app.ts", "posix")).toBe("src/app.ts");
    expect(normalizePatchPath("a/a/src/app.ts", "posix")).toBe("a/src/app.ts");
  });

  it("rejects traversal, absolute, drive, UNC, NUL and empty paths", () => {
    expect(() => normalizePatchPath("../secret", "posix")).toThrow();
    expect(() => normalizePatchPath("a/../secret", "posix")).toThrow();
    expect(() => normalizePatchPath("/abs/path", "posix")).toThrow();
    expect(() => normalizePatchPath("C:/secret", "windows")).toThrow();
    expect(() => normalizePatchPath("c:\\secret", "windows")).toThrow();
    expect(() => normalizePatchPath("//server/share", "windows")).toThrow();
    expect(() => normalizePatchPath("", "posix")).toThrow();
    expect(() => normalizePatchPath("a/", "posix")).toThrow();
    expect(() => normalizePatchPath("src/x\u0000y.ts", "posix")).toThrow();
  });

  it("rejects backslashes and duplicate slashes", () => {
    expect(() => normalizePatchPath("src\\app.ts", "windows")).toThrow();
    expect(() => normalizePatchPath("src\\app.ts", "posix")).toThrow();
    expect(() => normalizePatchPath("src//app.ts", "posix")).toThrow();
    expect(() => normalizePatchPath("src/app.ts/", "posix")).toThrow();
  });

  it("rejects dot segments that alias the same target path", () => {
    expect(() => normalizePatchPath("a/./x.txt", "posix")).toThrow();
    expect(() => normalizePatchPath("src/./x.txt", "windows")).toThrow();
  });

  it("does not treat /dev/null as a normal path", () => {
    expect(() => normalizePatchPath("/dev/null", "posix")).toThrow();
  });
});

describe("patchPathIdentity", () => {
  it("folds case and separators only for windows", () => {
    expect(patchPathIdentity("Src/App.ts", "windows")).toBe("src/app.ts");
    expect(patchPathIdentity("Src/App.ts", "posix")).toBe("Src/App.ts");
  });
});
