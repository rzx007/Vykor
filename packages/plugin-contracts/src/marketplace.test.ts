import { describe, expect, it } from "vitest";
import {
  compareMarketplaceVersions,
  parseMarketplaceDocument,
  satisfiesMarketplaceMinimum,
} from "./marketplace.js";

const valid = () => ({
  schemaVersion: 1,
  id: "sample-market",
  name: "示例市场",
  owner: { name: "Vykor" },
  plugins: [
    {
      id: "example.notes-app",
      name: "notes-app",
      version: "1.0.2",
      category: "productivity",
      componentTypes: ["apps", "mcp"],
      artifact: {
        url: "https://example.com/notes-1.0.2.zip",
        sha256: "a".repeat(64),
        size: 300,
      },
      requires: { host: ">=1.2.20", node: ">=24.0.0" },
      source: {
        repository: "https://github.com/rzx007/Vykor",
        commit: "b".repeat(40),
        path: "examples/plugins/notes-app",
      },
    },
  ],
});

describe("marketplace distribution contract", () => {
  it("accepts a complete release and returns detached data", () => {
    const input = valid();
    const result = parseMarketplaceDocument(input);
    input.plugins[0]!.version = "9.0.0";
    expect(result.plugins[0]!.version).toBe("1.0.2");
  });
  it("preserves author icons and detail content without requiring them in older catalogs", () => {
    const input = valid();
    Object.assign(input.plugins[0]!, {
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      introduction: "## 笔记\n\n保留草稿，并引用选区。",
      homepage: "https://example.com/notes",
      prompts: [{ title: "整理笔记", prompt: "保留原文，为这篇笔记整理提纲。" }],
    });
    expect(parseMarketplaceDocument(input).plugins[0]).toMatchObject({
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      introduction: "## 笔记\n\n保留草稿，并引用选区。",
      homepage: "https://example.com/notes",
      prompts: [{ title: "整理笔记", prompt: "保留原文，为这篇笔记整理提纲。" }],
    });
    expect(parseMarketplaceDocument(valid()).plugins[0]).not.toHaveProperty("icon");
  });
  it.each([
    { prompts: [{ title: "", prompt: "整理资料" }] },
    { prompts: [{ title: "整理资料", prompt: " " }] },
    { prompts: Array.from({ length: 17 }, () => ({ title: "示例", prompt: "整理资料" })) },
    { prompts: [{ title: "a".repeat(101), prompt: "整理资料" }] },
    { prompts: [{ title: "示例", prompt: "a".repeat(16385) }] },
  ])("rejects invalid author examples %#", ({ prompts }) => {
    const input = valid();
    Object.assign(input.plugins[0]!, { prompts });
    expect(() => parseMarketplaceDocument(input)).toThrow();
  });
  it.each(["javascript:alert(1)", "file:///private/icon.svg", "data:text/html;base64,PHN2Zy8+", "data:image/png;base64,broken"])("rejects invalid market icon %s", icon => {
    const input = valid();
    Object.assign(input.plugins[0]!, { icon });
    expect(() => parseMarketplaceDocument(input)).toThrow();
  });
  it.each([
    (x: ReturnType<typeof valid>) => {
      x.plugins.push(x.plugins[0]!);
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.artifact.url = "http://example.com/a.zip";
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.artifact.sha256 = "wrong";
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.artifact.size = 101 * 1024 * 1024;
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.requires.host = "whatever";
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.source.path = "../outside";
    },
    (x: ReturnType<typeof valid>) => {
      x.plugins[0]!.version = "1.0.0-preview";
    },
  ])("rejects inconsistent or unsafe catalog data %#", (mutate) => {
    const input = valid();
    mutate(input);
    expect(() => parseMarketplaceDocument(input)).toThrow();
  });
  it("compares semantic components numerically and enforces declared minimums", () => {
    expect(compareMarketplaceVersions("1.10.0", "1.9.20")).toBeGreaterThan(0);
    expect(satisfiesMarketplaceMinimum("24.0.0", ">=24.0.0")).toBe(true);
    expect(satisfiesMarketplaceMinimum("22.20.0", ">=24.0.0")).toBe(false);
    expect(() => compareMarketplaceVersions("garbage", "1.0.0")).toThrow();
  });
});
