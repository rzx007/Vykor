import { describe, expect, it } from "vitest";
import { extractThinkBlocks } from "./think-blocks.js";

describe("extractThinkBlocks", () => {
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
