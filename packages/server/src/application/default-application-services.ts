import type { AgentPersonaService } from "./settings-api.js";
import type { AgentEnvironmentSettings } from "@vykor/core";
import { createHash } from "node:crypto";
import { preflightWsl } from "@vykor/sandbox";
import {
  createDefaultAuthService,
  createDefaultContextService,
  createDefaultDreamService,
  createDefaultGitService,
  createDefaultHooksService,
  createDefaultMemoryService,
  createDefaultModelService,
  createDefaultOutputStyleService,
  createDefaultPluginService,
  createDefaultProfileService,
  createDefaultProjectInitService,
  createDefaultProviderService,
  createDefaultSettingsService,
  type DaemonSettingsRef,
} from "./default-services/index.js";

export type { DaemonSettingsRef } from "./default-services/index.js";
export {
  createDefaultSettingsService,
  createDefaultProviderService,
  createDefaultModelService,
  createDefaultAuthService,
  createDefaultMemoryService,
  createDefaultContextService,
  createDefaultDreamService,
  createDefaultProfileService,
  createDefaultOutputStyleService,
  createDefaultProjectInitService,
  createDefaultPluginService,
  createDefaultHooksService,
  createDefaultGitService,
};

export function createDefaultAgentPersonaService(): AgentPersonaService {
  return {
    async list() {
      const { getAllAgentDefinitions } =
        await import("@vykor/coordinator");
      const agents = getAllAgentDefinitions([]);
      return {
        agents: agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          ...(agent.source ? { source: agent.source } : {}),
          ...(agent.model ? { model: agent.model } : {}),
        })),
      };
    },
  };
}

/** Complete resource-service set installed by the opinionated daemon application. */
export function createDefaultApplicationServices(ref: DaemonSettingsRef, activeDefault?: AgentEnvironmentSettings) {
  return {
    settings: createDefaultSettingsService(ref, {
      agentEnvironment: createDefaultAgentEnvironmentService(activeDefault ?? ref.current.agentEnvironment),
    }),
    provider: createDefaultProviderService(ref),
    model: createDefaultModelService(ref),
    memory: createDefaultMemoryService(),
    auth: createDefaultAuthService(),
    context: createDefaultContextService(ref),
    dream: createDefaultDreamService(ref),
    profile: createDefaultProfileService(),
    outputStyle: createDefaultOutputStyleService(),
    projectInit: createDefaultProjectInitService(),
    plugin: createDefaultPluginService(ref),
    agentPersona: createDefaultAgentPersonaService(),
    hooks: createDefaultHooksService(ref),
    git: createDefaultGitService(),
  };
}

function createDefaultAgentEnvironmentService(activeDefault?: AgentEnvironmentSettings) {
  let cached: { expiresAt: number; wsl: boolean } | undefined;
  let inFlight: Promise<boolean> | undefined;
  const probe = async (): Promise<boolean> => {
    if (process.platform !== "win32") return false;
    if (cached && cached.expiresAt > Date.now()) return cached.wsl;
    inFlight ??= preflightWsl().then(
      () => true,
      () => false,
    );
    const wsl = await inFlight;
    inFlight = undefined;
    cached = { expiresAt: Date.now() + 30_000, wsl };
    return wsl;
  };
  return {
    active: () => activeDefault,
    async capabilities() {
      return { native: true as const, wsl: await probe(), ...(activeDefault ? { activeDefault: {
        kind: activeDefault.kind, ...(activeDefault.distribution ? { distribution: activeDefault.distribution } : {}),
        fingerprint: createHash("sha256").update(JSON.stringify(activeDefault)).digest("hex"),
      } } : {}) };
    },
    async validate(kind: "native" | "wsl") {
      if (kind === "native") return;
      await preflightWsl();
      cached = { expiresAt: Date.now() + 30_000, wsl: true };
    },
  };
}
