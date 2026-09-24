import { describe, it, expect } from "vitest";
import { buildOutputStyleResult } from "./slash-helpers.js";
import type { OutputStyleDefinition } from "@vykor/output-styles";

const STYLES: OutputStyleDefinition[] = [
  { name: "default", content: "Standard rich console output.", source: "builtin" },
  { name: "minimal", content: "Very terse plain-text output.", source: "builtin" },
  { name: "codex", content: "Codex-like compact transcript and tool output.", source: "builtin" },
  { name: "mine", content: "custom", source: "user" },
];

describe("buildOutputStyleResult", () => {
  it("empty args shows current style", () => {
    const r = buildOutputStyleResult("", STYLES, "minimal");
    expect(r.message).toBe("Output style: minimal");
    expect(r.newStyle).toBeUndefined();
  });

  it("'show' shows current style", () => {
    expect(buildOutputStyleResult("show", STYLES, "default").message).toBe("Output style: default");
  });

  it("'list' lists all with source and marks the active one", () => {
    const r = buildOutputStyleResult("list", STYLES, "minimal");
    expect(r.message).toContain("* minimal [builtin]");
    expect(r.message).toContain("  default [builtin]");
    expect(r.message).toContain("  mine [user]");
    expect(r.newStyle).toBeUndefined();
  });

  it("'set NAME' switches to a known style", () => {
    const r = buildOutputStyleResult("set codex", STYLES, "default");
    expect(r.newStyle).toBe("codex");
    expect(r.message).toBe("Output style set to codex");
    expect(r.isError).toBeFalsy();
  });

  it("bare NAME switches to a known style", () => {
    const r = buildOutputStyleResult("minimal", STYLES, "default");
    expect(r.newStyle).toBe("minimal");
  });

  it("accepts a user style by name", () => {
    expect(buildOutputStyleResult("mine", STYLES, "default").newStyle).toBe("mine");
  });

  it("unknown style returns an error and does not switch", () => {
    const r = buildOutputStyleResult("set nope", STYLES, "default");
    expect(r.isError).toBe(true);
    expect(r.message).toBe("Unknown output style: nope");
    expect(r.newStyle).toBeUndefined();
  });

  it("bare unknown name also errors", () => {
    const r = buildOutputStyleResult("bogus", STYLES, "default");
    expect(r.isError).toBe(true);
    expect(r.newStyle).toBeUndefined();
  });

  it("bare 'set' is treated as style name 'set' (unknown) — faithful to Python quirk", () => {
    const r = buildOutputStyleResult("set", STYLES, "default");
    expect(r.isError).toBe(true);
    expect(r.message).toBe("Unknown output style: set");
  });

  it("multi-token non-set input shows usage", () => {
    const r = buildOutputStyleResult("foo bar", STYLES, "default");
    expect(r.message).toContain("Usage:");
    expect(r.newStyle).toBeUndefined();
  });

  it("'set' keeps the whole remainder as the name (maxsplit=1 parity)", () => {
    // `set foo bar` → 名为 "foo bar"(未知),不静默丢掉 "bar"。
    const r = buildOutputStyleResult("set foo bar", STYLES, "default");
    expect(r.isError).toBe(true);
    expect(r.message).toBe("Unknown output style: foo bar");
  });

  it("'set NAME' with extra spaces still resolves a known style", () => {
    const r = buildOutputStyleResult("set   minimal", STYLES, "default");
    expect(r.newStyle).toBe("minimal");
  });
});
