import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPromptLayers, buildRuntimeSystemPrompt, buildPromptLedgerSegments, buildReplyStyleSection } from "../index.js";

describe("reply style prompt assembly", () => {
  let cwd: string;
  let previousConfigDir: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vykor-reply-prompt-"));
    previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = cwd;
  });
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("selects the collaborative style when no preference is supplied", async () => {
    const prompt = await buildRuntimeSystemPrompt({ cwd });
    expect(prompt).toContain("# Reply Style: Collaborative");
    expect(prompt.match(/# Reply Style:/g)).toHaveLength(1);
  });

  it.each([
    ["collaborative", "Collaborative"], ["direct", "Direct"], ["explanatory", "Explanatory"],
  ] as const)("assembles %s independently of progress notification mode", async (replyStyle, title) => {
    for (const workStyle of ["practical", "efficient"] as const) {
      const prompt = await buildRuntimeSystemPrompt({ cwd, replyStyle, workStyle });
      expect(prompt).toContain(`# Reply Style: ${title}`);
      expect(prompt.match(/# Reply Style:/g)).toHaveLength(1);
      expect(prompt).toContain(workStyle === "practical" ? "# Work Style: Practical" : "# Work Style: Efficient");
    }
  });

  it("retains personal and task instructions alongside the selected style", async () => {
    writeFileSync(join(cwd, "SOUL.md"), "You are a careful project collaborator.");
    writeFileSync(join(cwd, "USER.md"), "Use Chinese explanations for this user.");
    const layers = await buildPromptLayers({ cwd, replyStyle: "explanatory", customPrompt: "Explain the risk before a schema migration." });
    expect(layers.stable.join("\n")).toContain("# Reply Style: Explanatory");
    expect(layers.stable.join("\n")).toContain("careful project collaborator");
    expect(layers.context.join("\n")).toContain("Explain the risk before a schema migration.");
    expect(layers.volatile.join("\n")).toContain("Use Chinese explanations");
  });

  it("includes the selected style in the model context ledger", async () => {
    const segments = await buildPromptLedgerSegments({ cwd, replyStyle: "direct" });
    expect(segments.filter(segment => segment.text.includes("# Reply Style:"))).toEqual([
      expect.objectContaining({ bucket: "system", text: expect.stringContaining("# Reply Style: Direct") }),
    ]);
  });

  it("keeps one effective style after generic stable guidance and before user instructions", async () => {
    const layers = await buildPromptLayers({
      cwd, replyStyle: "direct", workStyle: "efficient", fastMode: true,
      includeDelegation: true, skillsList: [{ name: "inspection", description: "Inspect the requested data." }],
      customPrompt: "Return one sentence for this task.",
    });
    expect(layers.stable.at(-1)?.includes("# Reply Style: Direct")).toBe(true);
    expect(layers.stable.filter(segment => segment.includes("# Reply Style:"))).toHaveLength(1);
    expect(layers.context.some(segment => segment.includes("Return one sentence for this task."))).toBe(true);
  });

  it("places the same shared guidance before each selected expression style", () => {
    const shared = ["collaborative", "direct", "explanatory"].map(style => {
      const prompt = buildReplyStyleSection(style as "collaborative" | "direct" | "explanatory");
      const prefix = prompt.slice(0, prompt.indexOf("# Reply Style:"));
      expect(prefix.trim().length).toBeGreaterThan(0);
      return prefix;
    });
    expect(new Set(shared).size).toBe(1);
  });
});
