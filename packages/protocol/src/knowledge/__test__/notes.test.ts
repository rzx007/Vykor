import { describe, expect, it } from "vitest";

import * as protocol from "../../index.js";

type CreateParser = (value: unknown) => { content: string };
type UpdateParser = (value: unknown) => {
  content: string;
  expectedRevision: number;
};

function noteApi(): {
  maxLength: number;
  parseCreate: CreateParser;
  parseUpdate: UpdateParser;
} {
  const candidate = protocol as Record<string, unknown>;
  expect(candidate.MAX_NOTE_CONTENT_LENGTH).toBe(100_000);
  expect(typeof candidate.parseCreateNoteInput).toBe("function");
  expect(typeof candidate.parseUpdateNoteInput).toBe("function");
  return {
    maxLength: candidate.MAX_NOTE_CONTENT_LENGTH as number,
    parseCreate: candidate.parseCreateNoteInput as CreateParser,
    parseUpdate: candidate.parseUpdateNoteInput as UpdateParser,
  };
}

describe("note request parsing", () => {
  it("validates conditional organization saves before storage", () => {
    const organization = {
      version: 1,
      folders: {},
      desktop: [{ type: "note", id: "a" }],
      folderItems: {},
    };
    expect(
      protocol.parseSaveNoteOrganizationInput({
        organization,
        expectedEtag: "e1",
      }),
    ).toEqual({ organization, expectedEtag: "e1" });
    expect(() =>
      protocol.parseSaveNoteOrganizationInput({ organization }),
    ).toThrow();
    expect(() =>
      protocol.parseSaveNoteOrganizationInput({
        organization: {
          ...organization,
          desktop: [...organization.desktop, ...organization.desktop],
        },
        expectedEtag: "e1",
      }),
    ).toThrow("重复归属");
    expect(() =>
      protocol.parseSaveNoteOrganizationInput({
        organization: {
          version: 1,
          folders: { f: { name: "x", createdAt: 0, updatedAt: 0 } },
          desktop: [{ type: "folder", id: "f" }],
          folderItems: { f: ["a"] },
        },
        expectedEtag: "e1",
      }),
    ).toThrow("至少需要两张");
    expect(() =>
      protocol.parseSaveNoteOrganizationInput({
        organization: {
          ...organization,
          desktop: [{ type: "note", id: "../outside" }],
        },
        expectedEtag: "e1",
      }),
    ).toThrow("ID");
    expect(() =>
      protocol.parseSaveNoteOrganizationInput({
        organization: {
          ...organization,
          desktop: Array.from({ length: 10_001 }, () => ({
            type: "note",
            id: "a",
          })),
        },
        expectedEtag: "e1",
      }),
    ).toThrow("过多");
  });
  it("preserves nonblank create content exactly", () => {
    expect(noteApi().parseCreate({ content: "  idea  " })).toEqual({
      content: "  idea  ",
    });
  });

  it("allows an existing note to be cleared", () => {
    expect(noteApi().parseUpdate({ content: "", expectedRevision: 2 })).toEqual(
      {
        content: "",
        expectedRevision: 2,
      },
    );
  });

  it("rejects a blank new note", () => {
    expect(() => noteApi().parseCreate({ content: "   " })).toThrow(
      "content must not be blank",
    );
  });

  it("rejects invalid revisions and unknown fields", () => {
    const { parseUpdate } = noteApi();
    expect(() => parseUpdate({ content: "x", expectedRevision: 0 })).toThrow(
      "expectedRevision must be a positive safe integer",
    );
    expect(() =>
      parseUpdate({ content: "x", expectedRevision: 1, id: "forged" }),
    ).toThrow("Unknown note field: id");
  });

  it("rejects content beyond the protocol limit", () => {
    const { maxLength, parseCreate } = noteApi();
    expect(() => parseCreate({ content: "x".repeat(maxLength + 1) })).toThrow(
      "content is too large",
    );
  });
});
