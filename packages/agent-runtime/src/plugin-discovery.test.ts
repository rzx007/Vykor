import { describe, expect, it } from "vitest";

import { discoverVykorExtensions } from "./plugin-discovery.js";

describe("plugin discovery boundary", () => {
  it("exposes the installed plugin discovery entry point", () => {
    expect(discoverVykorExtensions).toBeTypeOf("function");
  });
});