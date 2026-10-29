import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NoteOrganizationRepository,
  NoteOrganizationConflictError,
  NoteOrganizationReadOnlyError,
  validateNoteOrganizationFiles,
} from "../note-organization-repository.js";
import { mergeNotes, reorderInContainer } from "../note-organization.js";
import { scanNoteIds } from "../markdown-note-files.js";

const faults = vi.hoisted(() => ({
  rename: "",
  overwriteAfterRename: "",
  symbolicPath: "",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      if (faults.symbolicPath === String(args[0]))
        Object.defineProperty(stat, "isSymbolicLink", { value: () => true });
      return stat;
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.rename === String(args[1]))
        throw new Error("simulated rename failure");
      actual.renameSync(...args);
      if (faults.overwriteAfterRename === String(args[1]))
        actual.writeFileSync(args[1], '{"version":2}');
    },
  };
});
const directories: string[] = [];
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "vk-organization-"));
  directories.push(dir);
  return new NoteOrganizationRepository(dir);
}
afterEach(() => {
  faults.rename = "";
  faults.overwriteAfterRename = "";
  faults.symbolicPath = "";
  for (const dir of directories.splice(0))
    rmSync(dir, { force: true, recursive: true });
});
describe("NoteOrganizationRepository", () => {
  it("rejects a save replaced before verification and keeps both recovery files", async () => {
    const repo = repository(),
      first = repo.read(["a", "b"]);
    const next = reorderInContainer(first.organization, {
      containerId: "desktop",
      activeId: "b",
      toIndex: 0,
    });
    faults.overwriteAfterRename = repo.path;
    await expect(repo.save(next, first.etag, ["a", "b"])).rejects.toThrow(
      "暂停整理写入",
    );
    expect(JSON.parse(readFileSync(repo.previousPath, "utf8"))).toEqual(
      first.organization,
    );
    await expect(
      repo.save(next, first.etag, ["a", "b"]),
    ).rejects.toBeInstanceOf(NoteOrganizationConflictError);
    expect(repo.read(["a", "b"]).readOnly).toBe(true);
    expect(readFileSync(repo.path, "utf8")).toBe('{"version":2}');
  });
  it("initializes, atomically saves Unicode and advances the baseline for consecutive saves", async () => {
    const repo = repository(),
      first = repo.read(["a", "b", "c"]);
    expect(JSON.parse(readFileSync(repo.path, "utf8"))).toEqual(
      first.organization,
    );
    const merged = mergeNotes(first.organization, {
      activeNoteId: "a",
      targetNoteId: "b",
      folderId: "f1",
      folderName: "研发😀",
      now: 10,
    });
    const second = await repo.save(merged, first.etag, ["a", "b", "c"]);
    expect(JSON.parse(readFileSync(repo.previousPath, "utf8"))).toEqual(
      first.organization,
    );
    const third = await repo.save(
      reorderInContainer(merged, {
        containerId: "desktop",
        activeId: "c",
        toIndex: 0,
      }),
      second.etag,
      ["a", "b", "c"],
    );
    expect(third.etag).not.toBe(second.etag);
    expect(repo.read(["a", "b", "c"])).toEqual(third);
    expect(
      readdirSync(repo.directory).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
  it("rejects stale and newly appeared disk baselines without replacing external contents", async () => {
    const repo = repository(),
      first = repo.read(["a", "b"]);
    const external = JSON.stringify({
      ...first.organization,
      desktop: [...first.organization.desktop].reverse(),
    });
    writeFileSync(repo.path, external);
    await expect(
      repo.save(first.organization, first.etag, ["a", "b"]),
    ).rejects.toBeInstanceOf(NoteOrganizationConflictError);
    expect(readFileSync(repo.path, "utf8")).toBe(external);
    await expect(
      repo.save(first.organization, "missing", ["a", "b"]),
    ).rejects.toBeInstanceOf(NoteOrganizationConflictError);
  });
  it("keeps future versions unchanged and read-only", async () => {
    const repo = repository();
    writeFileSync(repo.path, '{"version":2,"custom":true}');
    const snapshot = repo.read(["a", "b"]);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.warning).toContain("升级应用");
    await expect(
      repo.save(snapshot.organization, snapshot.etag, ["a", "b"]),
    ).rejects.toBeInstanceOf(NoteOrganizationReadOnlyError);
    expect(readFileSync(repo.path, "utf8")).toBe('{"version":2,"custom":true}');
    expect(readdirSync(repo.directory)).toEqual(["organization.json"]);
  });
  it("preserves each corrupt source under a unique name and repairs references", () => {
    const repo = repository();
    writeFileSync(repo.path, "{broken");
    expect(repo.read(["a", "b"]).warning).toContain("损坏");
    writeFileSync(repo.path, '{"version":1,"folders":false}');
    expect(repo.read(["a", "b"]).warning).toContain("损坏");
    const copies = readdirSync(repo.directory).filter((name) =>
      name.startsWith("organization.corrupt-"),
    );
    expect(copies).toHaveLength(2);
    expect(
      copies.map((name) => readFileSync(join(repo.directory, name), "utf8")),
    ).toContain("{broken");
    const current = repo.read(["b", "new"]);
    expect(current.organization.desktop.map((item) => item.id)).toEqual([
      "b",
      "new",
    ]);
  });
  it("preserves the old organization and cleans temporary files when atomic replacement fails", async () => {
    const repo = repository(),
      first = repo.read(["a", "b"]),
      original = readFileSync(repo.path, "utf8");
    const next = reorderInContainer(first.organization, {
      containerId: "desktop",
      activeId: "b",
      toIndex: 0,
    });
    faults.rename = repo.path;
    await expect(repo.save(next, first.etag, ["a", "b"])).rejects.toThrow(
      "rename failure",
    );
    expect(readFileSync(repo.path, "utf8")).toBe(original);
    expect(
      readdirSync(repo.directory).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
  it("rejects unsafe directories and non-regular organization paths", () => {
    const repo = repository();
    mkdirSync(repo.path);
    expect(() => repo.read([])).toThrow("普通文件");
    const link = join(repo.directory, "link");
    mkdirSync(link);
    // Sandbox cannot create Windows junctions; inject the filesystem's link flag.
    faults.symbolicPath = link;
    expect(() => new NoteOrganizationRepository(link).read([])).toThrow(
      "普通目录",
    );
  });
  it("scans only safe ordinary Markdown files and ignores organization metadata", () => {
    const repo = repository();
    writeFileSync(join(repo.directory, "a.md"), Buffer.from([0xff]));
    writeFileSync(repo.path, "metadata is not Markdown");
    expect(scanNoteIds(repo.directory)).toEqual(["a"]);
    faults.symbolicPath = join(repo.directory, "a.md");
    expect(() => scanNoteIds(repo.directory)).toThrow("普通文件");
    faults.symbolicPath = "";
    mkdirSync(join(repo.directory, "folder.md"));
    expect(() => scanNoteIds(repo.directory)).toThrow("普通文件");
    rmdirSync(join(repo.directory, "folder.md"));
    writeFileSync(join(repo.directory, "unsafe!.md"), "unsafe");
    expect(() => scanNoteIds(repo.directory)).toThrow("Invalid note file ID");
    rmSync(join(repo.directory, "unsafe!.md"));
    writeFileSync(join(repo.directory, "__proto__.md"), "unsafe");
    expect(() => scanNoteIds(repo.directory)).toThrow("Invalid note file ID");
  });
  it("validates restored organizations without repairing backups and accepts absent old files", () => {
    const repo = repository();
    expect(() =>
      validateNoteOrganizationFiles(repo.directory, ["a"]),
    ).not.toThrow();
    repo.read(["a", "b"]);
    expect(() =>
      validateNoteOrganizationFiles(repo.directory, ["a"]),
    ).toThrow();
    writeFileSync(repo.path, '{"version":3}');
    expect(() =>
      validateNoteOrganizationFiles(repo.directory, ["a", "b"]),
    ).toThrow("升级应用");
    expect(() =>
      validateNoteOrganizationFiles(repo.directory, ["a", "b"], true),
    ).not.toThrow();
  });
  it("allows historical previous references but rejects duplicate ownership without rewriting a backup", () => {
    const repo = repository();
    repo.read(["a", "b"]);
    const latest = repo.read(["b"]);
    expect(() =>
      validateNoteOrganizationFiles(repo.directory, ["b"]),
    ).not.toThrow();
    const invalid = JSON.stringify({
      ...latest.organization,
      desktop: [
        { type: "note", id: "b" },
        { type: "note", id: "b" },
      ],
    });
    writeFileSync(repo.previousPath, invalid);
    const current = readFileSync(repo.path, "utf8");
    expect(() => validateNoteOrganizationFiles(repo.directory, ["b"])).toThrow(
      "重复归属",
    );
    expect(readFileSync(repo.path, "utf8")).toBe(current);
    expect(readFileSync(repo.previousPath, "utf8")).toBe(invalid);
  });
});
