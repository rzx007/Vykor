import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptLedgerSegments } from "../ledger-segments.js";
import { buildTaggedPromptSegments } from "../prompt-segments-assembly.js";

describe("buildPromptLedgerSegments", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oh-ledger-segments-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("tags skills catalog as skills and delegation as subagents", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      includeDelegation: true,
      skillsList: [{ name: "foo", description: "bar" }],
    });
    expect(
      segments.some((s) => s.bucket === "skills" && s.text.includes("foo")),
    ).toBe(true);
    expect(segments.some((s) => s.bucket === "subagents")).toBe(true);
    expect(segments.some((s) => s.bucket === "system")).toBe(true);
  });

  it("assigns buckets at assembly push sites, not by header heuristics", async () => {
    const tagged = await buildTaggedPromptSegments({
      cwd: tmpDir,
      includeDelegation: true,
      skillsList: [{ name: "foo", description: "bar" }],
    });
    const skillsSeg = tagged.find((s) => s.text.includes("foo"));
    expect(skillsSeg?.bucket).toBe("skills");
    expect(skillsSeg?.layer).toBe("stable");

    const delegationSegs = tagged.filter((s) => s.bucket === "subagents");
    expect(delegationSegs).toHaveLength(1);
    expect(delegationSegs[0]?.layer).toBe("stable");
  });

  it("puts one Markdown presentation policy in the stable system bucket", async () => {
    const tagged = await buildTaggedPromptSegments({ cwd: tmpDir });
    const presentation = tagged.filter((segment) =>
      segment.text.includes("# Markdown Presentation"),
    );
    expect(presentation).toHaveLength(1);
    expect(presentation[0]).toMatchObject({
      layer: "stable",
      bucket: "system",
    });
  });

  it("does not put full memory preview into segments by default", async () => {
    const segments = await buildPromptLedgerSegments({ cwd: tmpDir });
    expect(segments.every((s) => s.bucket !== "conversation")).toBe(true);
  });

  it("excludes memoryContent from segments even when provided", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      memoryContent: "remember this secret preview",
    });
    expect(
      segments.every((s) => !s.text.includes("remember this secret preview")),
    ).toBe(true);
    expect(segments.every((s) => s.bucket !== "conversation")).toBe(true);
  });

  it("maps memoryReminderText to conversation bucket", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      memoryReminderText: "Relevant memory: user prefers TypeScript.",
    });
    expect(
      segments.some(
        (s) => s.bucket === "conversation" && s.text.includes("TypeScript"),
      ),
    ).toBe(true);
  });
});
