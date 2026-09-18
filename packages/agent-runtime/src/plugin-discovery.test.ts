import { describe, expect, it } from "vitest";

import { discoverOpenHarnessExtensions } from "./plugin-discovery.js";

describe("plugin discovery boundary", () => {
  it("exposes the installed plugin discovery entry point", () => {
    expect(discoverOpenHarnessExtensions).toBeTypeOf("function");
  });
});