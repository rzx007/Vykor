import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPromptLayers, buildRuntimeSystemPrompt, buildPromptLedgerSegments, buildReplyStyleSection } from "../index.js";

describe("communication prompt assembly", () => {
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

  it("honors personal instructions with default communication guidance", async () => {
    writeFileSync(join(cwd, "USER.md"), "Use Chinese explanations for this user.");
    const prompt = await buildRuntimeSystemPrompt({ cwd, customPrompt: "Explain the migration risk." });
    expect(prompt).toContain(buildReplyStyleSection());
    expect(prompt).toContain("before the first tool call");
    expect(prompt).toContain("Explain the migration risk.");
    expect(prompt).toContain("Use Chinese explanations for this user.");
    expect(prompt).not.toContain("# Reply Style:");
  });

  it("counts the same communication guidance in the context ledger", async () => {
    const layers = await buildPromptLayers({ cwd });
    const segments = await buildPromptLedgerSegments({ cwd });
    expect(layers.stable.at(-1)).toBe(buildReplyStyleSection());
    expect(segments).toContainEqual(expect.objectContaining({ bucket: "system", text: buildReplyStyleSection() }));
  });
});
