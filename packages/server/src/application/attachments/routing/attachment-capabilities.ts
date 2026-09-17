import type {
  ModelsDevModel,
  ProviderInputCapabilities,
} from "@openharness/api";
import {
  findByName,
  providerInputCapabilities,
} from "@openharness/api";
import type {
  Settings,
  InputSupport,
  ModelInputCapabilities,
} from "@openharness/core";
import type { SessionRuntimeConfig } from "@openharness/protocol";
import type { ModelProviderInfo } from "../settings-api.js";

export function modelInputCapabilities(
  model: Pick<ModelsDevModel, "id" | "modalities">,
): ModelInputCapabilities {
  const inputs = model.modalities?.input;
  if (!inputs) return { image: "unknown" };
  return { image: inputs.includes("image") ? "native" : "unsupported" };
}

export function normalizeInputSupport(value: unknown): InputSupport {
  return value === "native" || value === "unsupported" ? value : "unknown";
}

export function resolveEffectiveImageSupport(
  model: ModelInputCapabilities,
  provider: ProviderInputCapabilities,
): InputSupport {
  if (model.image === "unsupported" || provider.image === "unsupported") {
    return "unsupported";
  }
  if (model.image === "unknown" || provider.image === "unknown") {
    return "unknown";
  }
  return "native";
}

export function resolveRuntimeAttachmentCapabilities(input: {
  runtime: SessionRuntimeConfig;
  settings?: Settings;
  modelProviders: ModelProviderInfo[];
}): {
  modelCapabilities: ModelInputCapabilities;
  providerCapabilities: ProviderInputCapabilities;
} {
  let providerName = input.runtime.provider;
  if (!providerName) {
    const matches = input.modelProviders.filter((provider) =>
      provider.models.some((model) => model.id === input.runtime.model),
    );
    if (matches.length === 1) providerName = matches[0]!.name;
  }
  const provider = providerName
    ? input.modelProviders.find((item) => item.name === providerName)
    : undefined;
  const model = provider?.models.find(
    (item) => item.id === input.runtime.model,
  );
  const modelCapabilities = model?.inputCapabilities ?? { image: "unknown" };

  const custom = providerName
    ? input.settings?.customProviders?.find((item) => item.id === providerName)
    : undefined;
  const backend = custom
    ? "openai_compat"
    : providerName
      ? findByName(providerName)?.backendType
      : input.runtime.apiFormat === "anthropic"
        ? "anthropic"
        : input.runtime.apiFormat === "openai"
          ? "openai_compat"
          : undefined;
  return {
    modelCapabilities,
    providerCapabilities: backend
      ? providerInputCapabilities(backend)
      : { image: "unknown", imageMediaTypes: [] },
  };
}
