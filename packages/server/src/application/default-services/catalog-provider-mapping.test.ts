import { describe, expect, it } from "vitest";

import {
  catalogModelContextWindow,
  catalogModelOutputLimit,
  catalogModelReasoningEfforts,
  findCatalogModelById,
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

describe("catalog model limits", () => {
  const catalog = {
    opencode: {
      models: {
        "deepseek-v4.1-flash": {
          id: "deepseek-v4.1-flash",
          limit: { context: 1_000_000, output: 384_000 },
        },
        broken: { limit: { context: 0, output: -5 } },
      },
    },
  } as never;

  it("reads context and output limits by model id", () => {
    expect(catalogModelContextWindow(catalog, "opencode", "deepseek-v4.1-flash")).toBe(1_000_000);
    expect(catalogModelOutputLimit(catalog, "opencode", "deepseek-v4.1-flash")).toBe(384_000);
  });

  it("returns undefined for non-positive, non-integer, or missing limits", () => {
    expect(catalogModelContextWindow(catalog, "opencode", "broken")).toBeUndefined();
    expect(catalogModelOutputLimit(catalog, "opencode", "broken")).toBeUndefined();
    expect(catalogModelOutputLimit(catalog, "opencode", "missing")).toBeUndefined();
  });
});

describe("findCatalogModelById", () => {
  const catalog = {
    "alpha-vendor": {
      models: {
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          limit: { context: 200_000, output: 64_000 },
        },
      },
    },
    "other-vendor": {
      models: {
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          limit: { context: 999_999, output: 1 },
        },
      },
    },
  } as never;

  it("matches by model id regardless of case and hyphens", () => {
    expect(findCatalogModelById(catalog, "CLAUDE-SONNET-4-5")).toMatchObject({
      limit: { context: 200_000, output: 64_000 },
    });
    expect(findCatalogModelById(catalog, "claudeSonnet45")).toMatchObject({
      limit: { context: 200_000, output: 64_000 },
    });
    expect(findCatalogModelById(catalog, "Claude_Sonnet_4_5")).toBeUndefined();
  });

  it("takes the first catalog hit and skips deprecated or alpha entries", () => {
    expect(findCatalogModelById(catalog, "claude-sonnet-4-5")).toMatchObject({
      limit: { context: 200_000 },
    });
    expect(
      findCatalogModelById(
        {
          vendor: {
            models: {
              draft: { id: "gpt-5.4", status: "alpha", limit: { context: 1 } },
              retired: { id: "gpt-5.4", status: "deprecated", limit: { context: 2 } },
              live: { id: "gpt-5.4", limit: { context: 3 } },
            },
          },
        } as never,
        "gpt-5.4",
      ),
    ).toMatchObject({ limit: { context: 3 } });
  });

  it("returns undefined for a blank id or no match", () => {
    expect(findCatalogModelById(catalog, "   ")).toBeUndefined();
    expect(findCatalogModelById({} as never, "claude-sonnet-4-5")).toBeUndefined();
  });
});
