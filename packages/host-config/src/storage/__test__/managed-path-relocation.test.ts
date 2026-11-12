import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertManagedPathBoundary, relocateManagedPath } from "../managed-path-relocation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("uses directory boundaries and the longest move, leaving external text alone", () => {
  const from = resolve("fixtures", ".vykor"), to = resolve("fixtures", "new-root");
  const moves = [{ kind: "user-root" as const, from, to }, {
    kind: "workspace" as const, from: join(from, "old-workspace"), to: join(to, "workspaces", "one"),
  }];
  expect(relocateManagedPath(join(from, "skills", "a"), moves)).toBe(join(to, "skills", "a"));
  expect(relocateManagedPath(join(from, "old-workspace", "a"), moves)).toBe(join(to, "workspaces", "one", "a"));
  const sibling = resolve("fixtures", ".vykor-other", "keep.txt");
  expect(relocateManagedPath(sibling, moves)).toBe(sibling);
  expect(relocateManagedPath("run --cwd /fixtures/.vykor", moves)).toBe("run --cwd /fixtures/.vykor");
});

it("compares Windows case and separators but keeps POSIX case", () => {
  expect(relocateManagedPath("c:/OLD/a.txt", [{ kind: "user-root", from: "C:\\old", to: "D:\\new" }])).toBe("D:\\new\\a.txt");
  expect(relocateManagedPath("/OLD/a.txt", [{ kind: "user-root", from: "/old", to: "/new" }])).toBe("/OLD/a.txt");
});

it("checks missing descendants against their nearest existing ancestor without creating them", async () => {
  const root = mkdtempSync(join(tmpdir(), "managed-boundary-")); roots.push(root);
  const scope = join(root, "scope"), outside = join(root, "outside");
  mkdirSync(scope); mkdirSync(outside);
  symlinkSync(outside, join(scope, "escape"), "junction");
  await expect(assertManagedPathBoundary(join(scope, "escape", "not-yet-created"), scope)).rejects.toThrow(/outside|escape/i);
  await expect(assertManagedPathBoundary(join(scope, "safe", "new"), scope)).resolves.toBeUndefined();
  expect(readdirSync(scope)).toEqual(["escape"]);
});
