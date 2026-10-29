import { describe, expect, it } from "vitest";
import {
  assertOrganizationInvariants,
  reconcileOrganization,
  mergeNotes,
  moveNoteToFolder,
  moveNoteToDesktop,
  dissolveFolder,
  reorderInContainer,
  renameFolder,
  parseNoteOrganization,
} from "../note-organization.js";

const desktop = (...ids: string[]) =>
  reconcileOrganization(undefined, ids).organization;
const folder = () =>
  mergeNotes(desktop("a", "b", "c"), {
    activeNoteId: "a",
    targetNoteId: "b",
    folderId: "f1",
    folderName: "周会",
    now: 10,
  });
describe("note organization pure model", () => {
  it("rejects the reserved desktop container name as a folder id", () => {
    expect(() =>
      mergeNotes(desktop("a", "b"), {
        activeNoteId: "a",
        targetNoteId: "b",
        folderId: "desktop",
        folderName: "冲突",
        now: 1,
      })
    ).toThrow("无效的文件夹 ID")
  })
  it("creates a default desktop and merges at the target's surviving position", () => {
    const before = desktop("a", "b", "c"),
      next = folder();
    expect(next.desktop).toEqual([
      { type: "folder", id: "f1" },
      { type: "note", id: "c" },
    ]);
    expect(next.folderItems.f1).toEqual(["b", "a"]);
    expect(before.desktop.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
  it("moves into folders, reorders and dissolves without losing notes", () => {
    const inside = moveNoteToFolder(folder(), {
      noteId: "c",
      folderId: "f1",
      index: 1,
    });
    expect(inside.folderItems.f1).toEqual(["b", "c", "a"]);
    const reordered = reorderInContainer(inside, {
      containerId: "f1",
      activeId: "a",
      toIndex: 0,
    });
    expect(reordered.folderItems.f1).toEqual(["a", "b", "c"]);
    expect(
      dissolveFolder(reordered, "f1").desktop.map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
  });
  it("returns the last note to the folder's old desktop position", () => {
    const next = moveNoteToDesktop(folder(), { noteId: "a", desktopIndex: 1 });
    expect(next.folders).toEqual({});
    expect(next.folderItems).toEqual({});
    expect(next.desktop.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });
  it("retains the first valid occurrence, drops unknown references and appends new Markdown", () => {
    const input = folder();
    input.folderItems.f1 = ["b", "missing", "a", "a"];
    input.desktop.push(
      { type: "note", id: "a" },
      { type: "folder", id: "gone" },
    );
    const next = reconcileOrganization(input, ["a", "b", "c", "new"]);
    expect(next.changed).toBe(true);
    expect(next.organization.folderItems.f1).toEqual(["b", "a"]);
    expect(next.organization.desktop.map((item) => item.id)).toEqual([
      "f1",
      "c",
      "new",
    ]);
    expect(
      reconcileOrganization(input, ["b", "c"]).organization.desktop.map(
        (item) => item.id,
      ),
    ).toEqual(["b", "c"]);
  });
  it("allows equal names, counts Unicode characters and rejects invalid ownership", () => {
    const first = mergeNotes(desktop("a", "b", "c", "d"), {
      activeNoteId: "a",
      targetNoteId: "b",
      folderId: "f1",
      folderName: "同名",
      now: 10,
    });
    const second = mergeNotes(first, {
      activeNoteId: "c",
      targetNoteId: "d",
      folderId: "f2",
      folderName: "同名",
      now: 10,
    });
    expect(second.folders.f1?.name).toBe(second.folders.f2?.name);
    expect(
      renameFolder(folder(), {
        folderId: "f1",
        name: "  " + "😀".repeat(80) + "  ",
        now: 20,
      }).folders.f1?.name,
    ).toHaveLength(160);
    expect(() =>
      renameFolder(folder(), {
        folderId: "f1",
        name: "😀".repeat(81),
        now: 20,
      }),
    ).toThrow("1–80");
    const duplicate = folder();
    duplicate.desktop.push({ type: "note", id: "a" });
    expect(() => parseNoteOrganization(duplicate)).toThrow("重复归属");
    expect(() => assertOrganizationInvariants(folder(), ["a", "b"])).toThrow();
  });
  it("checks current note IDs while parsing and keeps the public assertion safe for malformed input", () => {
    expect(parseNoteOrganization(folder(), ["a", "b", "c"])).toEqual(folder());
    expect(() => parseNoteOrganization(folder(), ["a", "b"])).toThrow(
      "不存在的便签",
    );
    expect(() =>
      parseNoteOrganization(folder(), ["a", "b", "c", "new"]),
    ).toThrow("缺少现有便签");
    const duplicate = folder();
    duplicate.desktop.push({ type: "note", id: "a" });
    expect(() => parseNoteOrganization(duplicate, ["a", "b", "c"])).toThrow(
      "重复归属",
    );
    const malformed = { ...folder(), desktop: "invalid" };
    expect(() => parseNoteOrganization(malformed)).toThrow();
    expect(() =>
      assertOrganizationInvariants(
        malformed as unknown as ReturnType<typeof folder>,
      ),
    ).toThrow();
  });
});
