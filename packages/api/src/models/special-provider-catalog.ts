import type { ModelsDevCatalog } from "./catalog";

export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

const CODEX_MULTIMODAL_INPUT = {
  input: ["text", "image", "pdf"],
  output: ["text", "image"],
};

export const SPECIAL_PROVIDER_CATALOG: ModelsDevCatalog = {
  codex: {
    id: "codex",
    name: "Codex Subscription",
    models: {
      "gpt-6.1-sol": {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-6.1-terra": {
        id: "gpt-6.1-terra",
        name: "GPT-6.1 Terra",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-6-sol": {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-6-luna": {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-terra": {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        tool_call: true,
        modalities: CODEX_MULTIMODAL_INPUT,
        limit: { context: 1_050_000, output: 128_000 },
      },
    },
  },
};
