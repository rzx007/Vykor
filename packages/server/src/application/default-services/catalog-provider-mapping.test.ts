import { describe, expect, it } from "vitest";

import {
  catalogModelReasoningEfforts,
  readCatalogProvider,
  reasoningEffortsFromModel,
} from "./catalog-provider-mapping.js";

describe("catalog provider aliases", () => {
  it.each([
    ["zhipu", "zhipuai"],
    ["moonshot", "moonshotai"],
  ])("maps the built-in %s provider to models.dev %s", (providerName, catalogId) => {
    const provider = { name: catalogId, models: { chat: {} } };

    expect(readCatalogProvider({ [catalogId]: provider }, providerName)).toBe(provider);
  });
});

describe("reasoning effort derivation", () => {
  it("returns effort values and drops null/non-string/blank entries", () => {
    expect(
      reasoningEffortsFromModel({
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", null, " ", 7, "high", "max"] },
        ],
      } as never),
    ).toEqual(["low", "high", "max"]);
  });

  it("trims whitespace around effort values so they match the trimmed sent value", () => {
    expect(
      reasoningEffortsFromModel({
        reasoning_options: [{ type: "effort", values: [" low ", "high"] }],
      } as never),
    ).toEqual(["low", "high"]);
  });

  it("returns undefined when there is no effort option", () => {
    expect(reasoningEffortsFromModel({ reasoning_options: [{ type: "toggle" }] } as never)).toBeUndefined();
    expect(reasoningEffortsFromModel({} as never)).toBeUndefined();
  });

  it("maps provider aliases and model ids", () => {
    const catalog = {
      zhipuai: {
        name: "Zhipu",
        models: {
          "glm-4.6": { id: "glm-4.6", reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
        },
      },
    } as never;
    expect(catalogModelReasoningEfforts(catalog, "zhipu", "glm-4.6")).toEqual(["low", "high"]);
    expect(catalogModelReasoningEfforts(catalog, "zhipu", "missing")).toBeUndefined();
    expect(catalogModelReasoningEfforts(catalog, undefined, "glm-4.6")).toBeUndefined();
  });
});
