import { describe, expect, it } from "vitest";
import type { ModelsDevCatalog } from "@vykor/api";

import { validateRequestSelection } from "./request-selection-validation.js";

const catalog = {
  openai: {
    id: "openai", name: "OpenAI", models: {
      first: { id: "first", reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
      second: { id: "second", reasoning_options: [{ type: "effort", values: ["low"] }] },
    },
  },
} as ModelsDevCatalog;

describe("validateRequestSelection", () => {
  it("rejects a model outside the selected provider", () => {
    expect(() => validateRequestSelection({
      catalog, provider: "openai", model: "missing", effort: "low", explicitEffort: false,
    })).toThrow(/model.*provider/i);
  });

  it("rejects an explicitly unsupported effort", () => {
    expect(() => validateRequestSelection({
      catalog, provider: "openai", model: "second", effort: "high", explicitEffort: true,
    })).toThrow(/effort/i);
  });

  it("clears an inherited effort unsupported by the selected model", () => {
    expect(validateRequestSelection({
      catalog, provider: "openai", model: "second", effort: "high", explicitEffort: false,
    })).toEqual({ effort: "" });
  });

  it("accepts a declared model and effort", () => {
    expect(validateRequestSelection({
      catalog, provider: "openai", model: "first", effort: "high", explicitEffort: true,
    })).toEqual({ effort: "high" });
  });
});
