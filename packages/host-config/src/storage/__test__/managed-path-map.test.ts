import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as paths from "../paths.js";

it("recognizes mapped workspace/channel paths and exclusions, and rejects malformed maps", () => {
  const root = paths.getDataRoot();
  const migrations = join(root, "data", "migrations");
  mkdirSync(migrations, { recursive: true });
  const legacy = join(root, "old-documents", "Vykor");
  const excluded = join(root, "retained");
  writeFileSync(join(migrations, "path-map.json"), JSON.stringify({ version: 1, moves: [
    { kind: "workspace", from: legacy, to: join(root, "workspaces") },
    { kind: "user-root", from: join(root, "private"), to: root },
  ], excludedRoots: [excluded] }));
  expect(paths.isManagedWorkspacePath(join(legacy, "x1"), root)).toBe(true);
  expect(paths.isManagedWorkspacePath(join(root, "channels", "chat"), root)).toBe(true);
  expect(paths.isManagedWorkspacePath(join(root, "private", "credentials.json"), root)).toBe(false);
  expect(paths.isHiddenManagedProjectPath(join(excluded, "staging"), root)).toBe(true);
  expect(paths.isManagedWorkspacePath(join(excluded, "staging"), root)).toBe(false);
  for (const invalid of [{ version: 2, moves: [] }, { version: 1, moves: [{ kind: "workspace", from: "relative", to: root }] }, { version: 1, moves: [], excludedRoots: [42] }]) {
    writeFileSync(join(migrations, "path-map.json"), JSON.stringify(invalid));
    expect(() => paths.getManagedWorkspaceRoots(root)).toThrow(/path-map/);
  }
});

it.each([
  ["C:/Users/tester/Documents/Vykor", "/Users/tester/Documents/Vykor/project", false],
  ["/Users/tester/Documents/Vykor", "C:/Users/tester/Documents/Vykor/project", false],
  ["C:/Users/tester/Documents/Vykor", "c:\\users\\tester\\documents\\vykor\\project", true],
  ["C:/Users/tester/Documents/Vykor", "C:/Users/tester/Documents/Vykor-backup/project", false],
  ["//server/share/workspaces", "//SERVER/SHARE/WORKSPACES/project", true],
  ["//server/share/workspaces", "\\\\SERVER\\share\\workspaces\\project", true],
  ["\\\\server\\share\\workspaces", "//SERVER/share/WORKSPACES/project", true],
  ["//server/share/workspaces", "//server/share/workspaces-backup/project", false],
  ["/home/tester/workspaces", "/home/tester/workspaces/project", true],
  ["/home/tester/workspaces", "/home/tester/WORKSPACES/project", false],
  ["/home/tester/workspaces", "/home/tester/workspaces-backup/project", false],
] as const)("matches historical root %s against %s as %s without borrowing a drive", (source, candidate, expected) => {
  const root = paths.getDataRoot();
  const migrations = join(root, "data", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "path-map.json"), JSON.stringify({ version: 1, moves: [
    { kind: "workspace", from: source, to: join(root, "workspaces") },
  ] }));

  expect(paths.isManagedWorkspacePath(candidate, root)).toBe(expected);
  expect(paths.isHiddenManagedProjectPath(candidate, root)).toBe(expected);
});

it("hides forward-slash UNC exclusions case-insensitively without treating them as workspaces", () => {
  const root = paths.getDataRoot();
  const migrations = join(root, "data", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "path-map.json"), JSON.stringify({
    version: 1, moves: [], excludedRoots: ["//server/share/retained"],
  }));

  expect(paths.isHiddenManagedProjectPath("//SERVER/SHARE/RETAINED/project", root)).toBe(true);
  expect(paths.isManagedWorkspacePath("//SERVER/SHARE/RETAINED/project", root)).toBe(false);
  expect(paths.isHiddenManagedProjectPath("//server/share/retained-backup/project", root)).toBe(false);
});
