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
