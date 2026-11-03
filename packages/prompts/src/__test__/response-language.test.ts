import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setHostResponseLocale } from "@vykor/agent-contracts";
import {
  buildPromptLayers,
  buildPromptLedgerSegments,
  buildRuntimeSystemPrompt,
  buildSystemPrompt,
  getBaseSystemPrompt,
} from "../index.js";

describe("response language in prompt assembly", () => {
  let cwd: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vykor-response-language-"));
    previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = cwd;
    setHostResponseLocale(undefined);
  });

  afterEach(() => {
    setHostResponseLocale(undefined);
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(["zh-CN", "en-US"])("uses the host language %s once in the runtime prompt and context ledger", async (locale) => {
    setHostResponseLocale(locale);

    const prompt = await buildRuntimeSystemPrompt({ cwd });
    expect(prompt).toContain(`Default response language: ${locale} (host system language).`);
    expect(prompt.match(/# Response Language/g)).toHaveLength(1);

    const segments = await buildPromptLedgerSegments({ cwd });
    expect(segments.filter(segment => segment.text.includes("# Response Language"))).toEqual([
      expect.objectContaining({ bucket: "system", text: expect.stringContaining(`Default response language: ${locale}`) }),
    ]);
  });

  it.each([
    ["base prompt", () => getBaseSystemPrompt()],
    ["legacy builder", (cwd: string) => buildSystemPrompt(undefined, cwd)],
  ] as const)("resolves language anew for each %s call", async (_name, build) => {
    for (const locale of ["zh-CN", "en-US", "zh-CN"]) {
      setHostResponseLocale(locale);
      const prompt = await build(cwd);
      expect(prompt).toContain(`Default response language: ${locale} (host system language).`);
      expect(prompt.match(/# Response Language/g)).toHaveLength(1);
    }
  });

  it("keeps the system language below explicit user, profile and custom instruction preferences", async () => {
    setHostResponseLocale("en-US");
    writeFileSync(join(cwd, "USER.md"), "Reply in Korean for this user.");

    const layers = await buildPromptLayers({ cwd, customPrompt: "Reply in Japanese for this task." });
    const stable = layers.stable.join("\n\n");
    expect(stable).toContain("Default response language: en-US");
    expect(stable).toContain("Explicit response-language preferences in the current user request, personal profile or custom instructions take precedence.");
    expect(layers.context.join("\n\n")).toContain("Reply in Japanese for this task.");
    expect(layers.volatile.join("\n\n")).toContain("Reply in Korean for this user.");
    expect(layers.stable.at(-1)).toContain("# Reply Style:");
  });
});
