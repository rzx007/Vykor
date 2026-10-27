import { describe, expect, it } from "vitest";
import { applyToolOutputBudget, executeToolWithTimeout } from "../query-tool-limits.js";

const ref = "[tool-output-ref: opaque://abc]";
const text = (content: ReturnType<typeof applyToolOutputBudget>) => content.filter((block) => block.type === "text").map((block) => block.text).join("");

describe("tool output history budget", () => {
  it("keeps one bounded independent reference and an accurate notice at a block boundary", () => {
    const policy = { inlineChars: 256, previewChars: 128 };

      const image = { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "AA==" } };
      const content = [
        { type: "text" as const, text: "a".repeat(128) }, image,
        { type: "text" as const, text: "b".repeat(300) },
        { type: "text" as const, text: ref },
        { type: "text" as const, text: ref },
      ];
      const once = applyToolOutputBudget(content, policy);
      expect(once).toContain(image);
      expect(once.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);
      expect(text(once)).toContain("输出已截断");
      expect(text(once)).not.toContain("b".repeat(100));
      const again = applyToolOutputBudget(once, policy);
      expect(again.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);

  });

  it("does not protect malformed, whitespace, or oversized reference blocks", () => {
    const content = [
      { type: "text" as const, text: "x".repeat(20000) },
      { type: "text" as const, text: "[tool-output-ref: has space]" },
      { type: "text" as const, text: `[tool-output-ref: ${"q".repeat(100)}]` },
    ];
    const result = applyToolOutputBudget(content);
    expect(text(result)).not.toContain("tool-output-ref");
  });
});

it("does not invoke if cancellation arrives before the scheduled invocation", async () => {
  const controller = new AbortController();
  let effects = 0;
  const pending = executeToolWithTimeout({ name: "Write", description: "fixture", inputSchema: { type: "object" },
    execute: async () => { effects++; return { content: [] }; },
  }, {}, { cwd: "/" }, 1_000, controller.signal);
  controller.abort(new Error("cancelled before invocation"));
  await expect(pending).rejects.toThrow("cancelled before invocation");
  expect(effects).toBe(0);
});

it("registers the actual invocation before execution and settles observation on rejection", async () => {
  const order: string[] = [];
  let reject!: (error: Error) => void;
  let observed: Promise<void> | undefined;
  const pending = executeToolWithTimeout({ name: "Write", description: "fixture", inputSchema: {},
    execute: () => { order.push("executed"); return new Promise((_resolve, rejectResult) => { reject = rejectResult; }); },
  }, {}, { cwd: "/" }, 1_000, undefined, undefined, settled => { order.push("observed"); observed = settled; });
  await Promise.resolve();
  expect(order).toEqual(["observed", "executed"]);
  reject(new Error("request failed"));
  await expect(pending).rejects.toThrow("request failed");
  await expect(observed).resolves.toBeUndefined();
});

it("does not start the tool when invocation observation fails", async () => {
  let effects = 0;
  const pending = executeToolWithTimeout({ name: "Write", description: "fixture", inputSchema: {},
    execute: async () => { effects++; return { content: [] }; },
  }, {}, { cwd: "/" }, 1_000, undefined, undefined, () => { throw new Error("owner unavailable"); });
  await expect(pending).rejects.toThrow("owner unavailable");
  expect(effects).toBe(0);
});

it("keeps the actual invocation barrier pending through late outcome auditing", async () => {
  let release!: () => void, releaseAudit!: () => void, auditEntered!: () => void;
  const invoked = new Promise<void>(done => { release = done; });
  const audit = new Promise<void>(done => { releaseAudit = done; });
  const entered = new Promise<void>(done => { auditEntered = done; });
  let observed!: Promise<void>, confirmed = false;
  const pending = executeToolWithTimeout({ name: "Read", description: "late actual read", inputSchema: {},
    execute: async () => { await invoked; return { content: [] }; },
  }, {}, { cwd: "/" }, 5, undefined, async () => { auditEntered(); await audit; }, settled => { observed = settled; });
  await expect(pending).rejects.toThrow("timed out");
  void observed.then(() => { confirmed = true; });
  release(); await entered;
  expect(confirmed).toBe(false);
  releaseAudit(); await observed;
  expect(confirmed).toBe(true);
});
