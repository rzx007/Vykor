import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import { describe, expect, it } from "vitest";

describe("diff@7 contract used by ApplyPatch", () => {
  it.each([
    ["update", "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n", "old\n", "new\n"],
    ["create", "--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+new\n", "", "new\n"],
    ["delete", "--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", "old\n", ""],
  ])("applies %s patches", (_name, patch, before, after) => {
    const parsed = parsePatch(patch);
    expect(parsed).toHaveLength(1);
    expect(applyPatch(before, parsed[0]!, { fuzzFactor: 0 })).toBe(after);
  });

  it("allows line-number drift when exact context is unique", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-target\n+changed\n";
    expect(applyPatch("prefix\ntarget\n", parsePatch(patch)[0]!, { fuzzFactor: 0 }))
      .toBe("prefix\nchanged\n");
  });

  it("applies multiple hunks to one file", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -3,1 +3,1 @@\n-c\n+C\n";
    expect(applyPatch("a\nb\nc\n", parsePatch(patch)[0]!, { fuzzFactor: 0 }))
      .toBe("A\nb\nC\n");
  });

  it("applies a LF patch to a CRLF file while preserving CRLF", () => {
    const source = "a\r\nb\r\nc\r\n";
    const patch = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    expect(applyPatch(source, parsePatch(patch)[0]!, { fuzzFactor: 0 }))
      .toBe("a\r\nB\r\nc\r\n");
  });

  it("requires a UTF-8 BOM to be stripped before applying", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-title\n+TITLE\n body\n";
    // jsdiff matches raw bytes: a BOM in the source breaks the first hunk.
    expect(applyPatch("\uFEFFtitle\nbody\n", parsePatch(patch)[0]!, { fuzzFactor: 0 })).toBe(false);
    expect(applyPatch("title\nbody\n", parsePatch(patch)[0]!, { fuzzFactor: 0 })).toBe("TITLE\nbody\n");
  });

  it("preserves the absence of a final newline", () => {
    const source = "a\nb";
    const patch = createTwoFilesPatch("x", "x", source, "a\nB", "", "", { context: 3 });
    expect(applyPatch(source, parsePatch(patch)[0]!, { fuzzFactor: 0 })).toBe("a\nB");
  });

  it("preserves CRLF line endings through a generated patch", () => {
    const source = "a\r\nb\r\nc\r\n";
    const patch = createTwoFilesPatch("x", "x", source, "a\r\nB\r\nc\r\n", "", "", { context: 3 });
    expect(applyPatch(source, parsePatch(patch)[0]!, { fuzzFactor: 0 })).toBe("a\r\nB\r\nc\r\n");
  });

  it("resolves repeated identical context to the first occurrence", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-target\n+changed\n";
    expect(applyPatch("target\ntarget\n", parsePatch(patch)[0]!, { fuzzFactor: 0 }))
      .toBe("changed\ntarget\n");
  });

  it("accepts non-overlapping hunks and rejects non-matching context with fuzzFactor 0", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-absent\n+changed\n";
    expect(applyPatch("present\n", parsePatch(patch)[0]!, { fuzzFactor: 0 })).toBe(false);
  });
});
