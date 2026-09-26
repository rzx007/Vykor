import { describe, it, expect, vi, afterEach } from "vitest";
import { EventRenderer } from "./renderer";

describe("EventRenderer", () => {
  let writeSpy: any;
  let errorSpy: any;

  afterEach(() => {
    writeSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  function spy() {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return { writeSpy, errorSpy };
  }

  it("renders text_delta events", async () => {
    spy();
    const renderer = new EventRenderer();
    await renderer.render({ type: "text_delta", delta: "Hello " });
    await renderer.render({ type: "text_delta", delta: "World" });
    expect(writeSpy).toHaveBeenCalledWith("Hello ");
    expect(writeSpy).toHaveBeenCalledWith("World");
    expect(renderer.getBuffer()).toBe("Hello World");
  });

  it("renders tool_use_start with summarized input", async () => {
    spy();
    const renderer = new EventRenderer();
    await renderer.render({
      type: "tool_use_start",
      toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } },
    });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Bash"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("ls -la"));
  });

  it("renders tool_use_end silently in non-verbose mode", async () => {
    spy();
    const renderer = new EventRenderer();
    await renderer.render({
      type: "tool_use_end",
      toolUseId: "tu1",
      result: { content: [{ type: "text", text: "output" }], isError: false },
    });
    const calls = writeSpy.mock.calls.map((c: any) => String(c[0]));
    const hasOutput = calls.some((c: string) => c.includes("output"));
    expect(hasOutput).toBe(false);
  });

  it("renders tool_use_end with output in verbose mode", async () => {
    spy();
    const renderer = new EventRenderer({ verbose: true });
    await renderer.render({
      type: "tool_use_end",
      toolUseId: "tu1",
      result: { content: [{ type: "text", text: "hello output" }], isError: false },
    });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("hello output"));
  });

  it("renders error events to stderr", async () => {
    spy();
    const renderer = new EventRenderer();
    await renderer.render({ type: "error", error: new Error("test error") });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("test error"));
  });

  it("marks previously printed output as interrupted when a model retry is scheduled", async () => {
    const { writeSpy, errorSpy } = spy();
    const renderer = new EventRenderer();
    await renderer.render({ type: "text_delta", delta: "partial" });
    await renderer.render({ type: "model_retry", generationId: "g1", attempt: 1, retryNumber: 2, maxRetries: 5, reason: "network", nextRetryAt: Date.now() + 2_000, recoveryDeadlineAt: Date.now() + 30_000 });
    expect(writeSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")).toBe("partial");
    expect(errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")).toContain("上一段输出中断，以下为重新生成");
    expect(renderer.getBuffer()).toBe("");
  });

  it("renders usage in verbose mode", async () => {
    spy();
    const renderer = new EventRenderer({ verbose: true });
    await renderer.render({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("100"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("50"));
  });

  it("skips usage in non-verbose mode", async () => {
    spy();
    const renderer = new EventRenderer({ verbose: false });
    await renderer.render({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining("tokens"));
  });

  it("renders complete event", async () => {
    spy();
    const renderer = new EventRenderer();
    await renderer.render({ type: "complete", stopReason: "end_turn" });
    expect(writeSpy).toHaveBeenCalledWith("\n");
  });

  it("reset clears buffer", async () => {
    const renderer = new EventRenderer();
    (renderer as any).buffer = "abc";
    renderer.reset();
    expect(renderer.getBuffer()).toBe("");
  });

  it("truncates long tool input in summary", async () => {
    spy();
    const renderer = new EventRenderer();
    const longCmd = "a".repeat(200);
    await renderer.render({
      type: "tool_use_start",
      toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: longCmd } },
    });
    const calls = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
    expect(calls).toContain("...");
  });

  describe("outputStyle: minimal", () => {
    it("tool_use_start uses '> name summary' (no ○ glyph)", async () => {
      spy();
      const renderer = new EventRenderer({ outputStyle: "minimal" });
      await renderer.render({
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
      });
      const out = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
      expect(out).toContain("> Bash ls");
      expect(out).not.toContain("○");
    });

    it("verbose tool_use_end uses plain indent (no ✓/✗ glyph)", async () => {
      spy();
      const renderer = new EventRenderer({ outputStyle: "minimal", verbose: true });
      await renderer.render({
        type: "tool_use_end",
        toolUseId: "tu1",
        result: { content: [{ type: "text", text: "done" }], isError: false },
      });
      const out = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
      expect(out).toContain("    done");
      expect(out).not.toContain("✓");
    });
  });

  describe("outputStyle: default/codex keep glyphs", () => {
    it("default tool_use_start keeps ○ glyph", async () => {
      spy();
      const renderer = new EventRenderer({ outputStyle: "default" });
      await renderer.render({
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
      });
      const out = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
      expect(out).toContain("○ Bash(ls)");
    });

    it("codex renders like default (○ glyph)", async () => {
      spy();
      const renderer = new EventRenderer({ outputStyle: "codex" });
      await renderer.render({
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
      });
      const out = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
      expect(out).toContain("○ Bash(ls)");
    });
  });

  it("setStyle switches rendering for subsequent events", async () => {
    spy();
    const renderer = new EventRenderer({ outputStyle: "default" });
    renderer.setStyle("minimal");
    await renderer.render({
      type: "tool_use_start",
      toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
    });
    const out = writeSpy.mock.calls.map((c: any) => String(c[0])).join("");
    expect(out).toContain("> Bash ls");
    expect(out).not.toContain("○");
  });
});
