import { describe, expect, it } from "vitest";
import { extractThinkBlocks } from "./think-blocks.js";

describe("extractThinkBlocks", () => {
  it.each(["think", "thinking"])("keeps %s reasoning out of visible text at every stream split", tag => {
    const source = `前文<${tag}>内部思考</${tag}>正文`;
    for (let size = 1; size <= source.length; size++) {
      let buffer = "", visible = "", reasoning = "";
      for (let i = 0; i < source.length; i += size) {
        const result = extractThinkBlocks(buffer + source.slice(i, i + size));
        buffer = result.leftover;
        visible += result.visible;
        reasoning += result.reasoning;
      }
      const tail = extractThinkBlocks(buffer, { final: true });
      expect(visible + tail.visible).toBe("前文正文");
      expect(reasoning + tail.reasoning).toBe("内部思考");
    }
  });

  it("handles mixed tag styles and unfinished thinking without exposing reasoning", () => {
    expect(extractThinkBlocks("<thinking>甲</thinking>中<think>乙</think>末")).toEqual({
      visible: "中末", reasoning: "甲乙", leftover: "",
    });
    expect(extractThinkBlocks("前<thinking>未完", { final: true })).toEqual({
      visible: "前", reasoning: "未完", leftover: "",
    });
  });
  it("splits a complete block into visible text and reasoning", () => {
    const result = extractThinkBlocks("before<think>secret</think>after");
    expect(result.visible).toBe("beforeafter");
    expect(result.reasoning).toBe("secret");
    expect(result.leftover).toBe("");
  });

  it("extracts multiple blocks", () => {
    const result = extractThinkBlocks("<think>a</think>mid<think>b</think>tail");
    expect(result.visible).toBe("midtail");
    expect(result.reasoning).toBe("ab");
  });

  it("holds back an unclosed block for the next chunk", () => {
    const result = extractThinkBlocks("before<think>partial");
    expect(result.visible).toBe("before");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("<think>partial");
  });

  it("holds back a partial opening tag split across chunks", () => {
    const result = extractThinkBlocks("before<thi");
    expect(result.visible).toBe("before");
    expect(result.leftover).toBe("<thi");
  });

  it("treats an unclosed block as reasoning at stream end", () => {
    const result = extractThinkBlocks("before<think>unfinished reasoning", { final: true });
    expect(result.visible).toBe("before");
    expect(result.reasoning).toBe("unfinished reasoning");
    expect(result.leftover).toBe("");
  });

  it("releases a partial tag prefix as visible text at stream end", () => {
    const result = extractThinkBlocks("before<thi", { final: true });
    expect(result.visible).toBe("before<thi");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("");
  });

  it("passes plain text through untouched", () => {
    const result = extractThinkBlocks("no tags here");
    expect(result.visible).toBe("no tags here");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("");
  });
});
