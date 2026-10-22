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
