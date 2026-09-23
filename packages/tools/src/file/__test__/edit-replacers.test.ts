import { describe, expect, it } from "vitest";

import {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EditMatchError,
  EscapeNormalizedReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  MultiOccurrenceReplacer,
  SimpleReplacer,
  TrimmedBoundaryReplacer,
  WhitespaceNormalizedReplacer,
  convertToLineEnding,
  detectLineEnding,
  editMatchMessage,
  isDisproportionateMatch,
  normalizeLineEndings,
  replace,
} from "../edit-replacers.js";
import type { Replacer } from "../edit-replacers.js";

describe("line endings", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("detects the file line ending", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
  });

  it("converts LF to the target ending", () => {
    expect(convertToLineEnding("a\nb\n", "\n")).toBe("a\nb\n");
    expect(convertToLineEnding("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });
});

describe("isDisproportionateMatch", () => {
  it("accepts a search of comparable size", () => {
    expect(isDisproportionateMatch("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 2;")).toBe(
      false,
    );
  });

  it("rejects a search spanning far more lines than oldString", () => {
    const oldString = "line1\nline2";
    const search = Array.from({ length: 20 }, (_, index) => `line${index}`).join("\n");
    expect(isDisproportionateMatch(search, oldString)).toBe(true);
  });

  it("rejects a multi-line search whose text is far longer than oldString", () => {
    const spaces = " ".repeat(600);
    expect(isDisproportionateMatch(`a${spaces}b\nc${spaces}d`, "a b\nc d")).toBe(true);
  });

  it("rejects a single-line candidate that is far longer than oldString", () => {
    expect(isDisproportionateMatch("x".repeat(2000), "x")).toBe(true);
  });
});

describe("EditMatchError", () => {
  it("carries a discriminating kind and the matching message", () => {
    const error = new EditMatchError("ambiguous");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EditMatchError");
    expect(error.kind).toBe("ambiguous");
    expect(error.message).toBe(editMatchMessage("ambiguous"));
  });

  it("exposes one distinct message per kind", () => {
    const kinds = ["identical", "not_found", "ambiguous", "disproportionate"] as const;
    const messages = kinds.map((kind) => editMatchMessage(kind));
    expect(new Set(messages).size).toBe(kinds.length);
  });
});

const collect = (replacer: Replacer, content: string, find: string): string[] => [
  ...replacer(content, find),
];

describe("SimpleReplacer", () => {
  it("yields the exact find string", () => {
    expect(collect(SimpleReplacer, "hello world", "world")).toEqual(["world"]);
  });

  it("yields nothing when content does not contain the find string", () => {
    expect(collect(SimpleReplacer, "hello", "missing")).toEqual([]);
  });
});

describe("LineTrimmedReplacer", () => {
  it("matches when only indentation differs", () => {
    const content = "function f() {\n    return 1;\n}";
    const find = "function f() {\n  return 1;\n}";
    const matches = collect(LineTrimmedReplacer, content, find);
    expect(matches).toContain("function f() {\n    return 1;\n}");
  });

  it("yields nothing when content differs", () => {
    expect(collect(LineTrimmedReplacer, "a\nb", "x\ny")).toEqual([]);
  });

  it("does not yield an empty line for a whitespace-only find", () => {
    expect(collect(LineTrimmedReplacer, "a\n\nb", "   ")).toEqual([]);
  });
});

describe("WhitespaceNormalizedReplacer", () => {
  it("matches when inner whitespace run length differs", () => {
    const matches = collect(WhitespaceNormalizedReplacer, "const a   =   1;", "const a = 1;");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("yields nothing when normalized text differs", () => {
    expect(collect(WhitespaceNormalizedReplacer, "const a = 1;", "const b = 2;")).toEqual([]);
  });

  it("never turns a whitespace-only find into an empty candidate", () => {
    expect(collect(WhitespaceNormalizedReplacer, "a\n\nb", "   ")).toEqual([]);
  });

  it("yields every differently-spaced match on the same line", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(collect(WhitespaceNormalizedReplacer, content, "const a = 1;")).toEqual([
      "const a   = 1;",
      "const a\t= 1;",
    ]);
  });

  it("yields overlapping differently-spaced matches on the same line", () => {
    expect(collect(WhitespaceNormalizedReplacer, "a  a\t a", "a a")).toEqual([
      "a  a",
      "a\t a",
    ]);
  });
});

describe("IndentationFlexibleReplacer", () => {
  it("matches a block that is indented differently as a whole", () => {
    const content = "    if (x) {\n      go();\n    }";
    const find = "if (x) {\n  go();\n}";
    expect(collect(IndentationFlexibleReplacer, content, find).length).toBeGreaterThan(0);
  });

  it("yields nothing when block content differs", () => {
    expect(collect(IndentationFlexibleReplacer, "  a\n  b", "a\nc")).toEqual([]);
  });
});

describe("EscapeNormalizedReplacer", () => {
  it("matches when the find string carries literal escape sequences", () => {
    const content = "const a = 1;\nconst b = 2;";
    const find = "const a = 1;\\nconst b = 2;";
    expect(collect(EscapeNormalizedReplacer, content, find)).toContain(
      "const a = 1;\nconst b = 2;",
    );
  });

  it("yields nothing when the unescaped text is absent", () => {
    expect(collect(EscapeNormalizedReplacer, "alpha", "beta\\ngamma")).toEqual([]);
  });
});

describe("TrimmedBoundaryReplacer", () => {
  it("matches when the find string has surrounding blank lines", () => {
    const matches = collect(TrimmedBoundaryReplacer, "target", "\n\ntarget\n\n");
    expect(matches).toContain("target");
  });

  it("yields nothing when trimming would produce an empty candidate", () => {
    expect(collect(TrimmedBoundaryReplacer, "a\n\nb", "  \n  ")).toEqual([]);
  });
});

describe("MultiOccurrenceReplacer", () => {
  it("yields one entry per occurrence", () => {
    expect(collect(MultiOccurrenceReplacer, "a-a-a", "a")).toEqual(["a", "a", "a"]);
  });

  it("yields nothing when the text is absent or find is empty", () => {
    expect(collect(MultiOccurrenceReplacer, "abc", "z")).toEqual([]);
    expect(collect(MultiOccurrenceReplacer, "abc", "")).toEqual([]);
  });
});

describe("BlockAnchorReplacer", () => {
  it("matches a block whose middle differs slightly", () => {
    const content = [
      "function f() {",
      "  const a = 1;",
      "  return a;",
      "}",
    ].join("\n");
    const find = ["function f() {", "  const a = 2;", "  return a;", "}"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toContain(content);
  });

  it("yields nothing for blocks shorter than three lines", () => {
    expect(collect(BlockAnchorReplacer, "a\nb", "a\nb")).toEqual([]);
  });

  it("yields nothing when the middle is too dissimilar", () => {
    const content = ["start", "totally different middle", "end"].join("\n");
    const find = ["start", "another unrelated middle", "end"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toEqual([]);
  });

  it("yields every block that passes the similarity threshold", () => {
    const content = [
      "head", "return alpha;", "tail", "gap",
      "head", "return alphi;", "tail",
    ].join("\n");
    const find = ["head", "return alphx;", "tail"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toHaveLength(2);
  });

  it("limits end-anchor scanning to the allowed block-size window", () => {
    const content = Array.from({ length: 30_000 }, () => "}").join("\n");
    const startedAt = performance.now();
    expect(collect(BlockAnchorReplacer, content, ["}", "missing", "}"].join("\n")))
      .toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("ContextAwareReplacer", () => {
  it("matches a block with matching anchors and mostly matching middle", () => {
    const content = ["head", "body line", "tail"].join("\n");
    const find = ["head", "body line", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toContain(content);
  });

  it("yields nothing for fewer than three lines", () => {
    expect(collect(ContextAwareReplacer, "a", "a")).toEqual([]);
  });

  it("yields nothing when fewer than half of the middle lines match", () => {
    const content = ["head", "one", "two", "three", "tail"].join("\n");
    const find = ["head", "x", "y", "three", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toEqual([]);
  });

  it("yields every block that satisfies the context threshold", () => {
    const content = [
      "head", "shared", "one", "tail", "gap",
      "head", "shared", "two", "tail",
    ].join("\n");
    const find = ["head", "shared", "expected", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toHaveLength(2);
  });

  it("does not scan every possible end anchor for a fixed-size block", () => {
    const content = Array.from({ length: 3_000 }, () => "}").join("\n");
    const startedAt = performance.now();
    expect(collect(ContextAwareReplacer, content, ["}", "missing", "}"].join("\n")))
      .toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("replace", () => {
  it("applies an exact unique match", () => {
    expect(replace("a b c", "b", "X")).toBe("a X c");
  });

  it("recovers when only indentation differs", () => {
    const content = "function f() {\n    return 1;\n}";
    const find = "function f() {\n  return 1;\n}";
    expect(replace(content, find, "function f() {\n  return 2;\n}")).toContain("return 2;");
  });

  it("throws identical when oldString equals newString", () => {
    expect(() => replace("abc", "b", "b")).toThrowError(EditMatchError);
    try {
      replace("abc", "b", "b");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("identical");
    }
  });

  it("throws not_found when nothing matches", () => {
    try {
      replace("abc", "zzz", "X");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("not_found");
    }
  });

  it("throws ambiguous when candidates are not unique", () => {
    try {
      replace("same\nother\nsame", "same", "X");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("ambiguous");
    }
  });

  it("replaces every occurrence when replaceAll is true", () => {
    expect(replace("a-a-a", "a", "b", true)).toBe("b-b-b");
  });

  it("rejects multiple different fuzzy locations instead of selecting the first", () => {
    const synthetic: Replacer = function* () {
      yield "alpha";
      yield "beta";
    };
    expect(() => replace("alpha / beta", "target", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("replaces all non-overlapping fuzzy locations when replaceAll is true", () => {
    const synthetic: Replacer = function* () {
      yield "alpha";
      yield "beta";
    };
    expect(replace("alpha / beta", "target", "X", true, [synthetic])).toBe("X / X");
  });

  it("rejects differently-spaced matches on the same line as ambiguous", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(() => replace(content, "const a = 1;", "X"))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("replaces every differently-spaced match on the same line", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(replace(content, "const a = 1;", "X", true)).toBe("X / X");
  });

  it("rejects overlapping differently-spaced matches", () => {
    expect(() => replace("a  a\t a", "a a", "X"))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping differently-spaced replaceAll matches", () => {
    expect(() => replace("a  a\t a", "a a", "X", true))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping replaceAll locations", () => {
    const synthetic: Replacer = function* () {
      yield "ab";
      yield "bc";
    };
    expect(() => replace("abc", "target", "X", true, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping locations produced by one candidate", () => {
    const synthetic: Replacer = function* () {
      yield "aa";
    };
    expect(() => replace("aaa", "target", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping replaceAll locations produced by one candidate", () => {
    const synthetic: Replacer = function* () {
      yield "aa";
    };
    expect(() => replace("aaa", "target", "X", true, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("ignores empty candidates in both branches", () => {
    const synthetic: Replacer = function* () {
      yield "";
    };
    for (const replaceAll of [false, true]) {
      expect(() => replace("abc", "   ", "X", replaceAll, [synthetic]))
        .toThrowError(expect.objectContaining({ kind: "not_found" }));
    }
  });

  it("throws disproportionate when a candidate spans far more than oldString", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    try {
      replace(search, "a\nb", "X", false, [synthetic]);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("disproportionate");
    }
  });

  it("applies the disproportionate guard in the replaceAll branch too", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    try {
      replace(search, "a\nb", "X", true, [synthetic]);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("disproportionate");
    }
  });

  it("reports ambiguity before checking a non-unique disproportionate candidate", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    const content = `${search}\nseparator\n${search}`;
    expect(() => replace(content, "a\nb", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });
});
