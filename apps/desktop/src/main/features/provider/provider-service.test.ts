import { beforeEach, describe, expect, it, vi } from "vitest"

const daemon = vi.hoisted(() => ({
  providers: {
    listProviders: vi.fn(),
    listModels: vi.fn(),
    connectCatalogProvider: vi.fn(),
    updateCatalogProviderHeaders: vi.fn(),
    disconnectCatalogProvider: vi.fn(),
    removeCustomProvider: vi.fn(),
  },
  auth: {
    getStatus: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
  system: {
    getSettings: vi.fn(),
    patchSettings: vi.fn(),
  },
}))

const sessionService = vi.hoisted(() => ({
  daemonClient: vi.fn(async () => daemon),
  refreshDaemonClient: vi.fn(async () => daemon),
}))

vi.mock("../session/session-service", () => ({
  desktopSessionService: sessionService,
}))

import {
  DesktopProviderService,
  buildDesktopProviderSnapshot,
} from "./provider-service"

describe("buildDesktopProviderSnapshot", () => {
  it("merges provider, auth, settings and model state without exposing credentials", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
        { name: "anthropic", displayName: "Anthropic", hasKey: true, active: false },
        { name: "codex", displayName: "Codex Subscription", hasKey: true, active: false },
      ],
      auth: {
        codex: {
          configured: true,
          state: "configured",
          source: "C:/Users/test/.codex/auth.json",
          profileLabel: "test@example.com",
        },
        storedProviders: ["openai"],
        envProviders: [{ name: "anthropic", envKey: "ANTHROPIC_API_KEY" }],
      },
      settings: { provider: "openai", model: "gpt-5.4" },
      models: [
        {
          name: "openai",
          displayName: "OpenAI",
          models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI", providerName: "openai" }],
        },
      ],
    })

    expect(snapshot.activeProvider).toBe("openai")
    expect(snapshot.activeModel).toBe("gpt-5.4")
    expect(snapshot.providers.find((item) => item.name === "openai")).toMatchObject({
      connected: true,
      active: true,
      credentialSource: "credentials",
      credentialLabel: "OpenHarness 密钥",
      currentModel: "gpt-5.4",
    })
    expect(snapshot.providers.find((item) => item.name === "anthropic")).toMatchObject({
      connected: true,
      credentialSource: "environment",
      credentialLabel: "ANTHROPIC_API_KEY",
    })
    expect(snapshot.providers.find((item) => item.name === "codex")).toMatchObject({
      connected: true,
      credentialSource: "subscription",
      credentialLabel: "test@example.com",
    })
    expect(snapshot.providers.map((item) => item.name)).toEqual(["openai", "anthropic", "codex"])
    expect(snapshot).not.toHaveProperty("subscriptions")
    expect(JSON.stringify(snapshot)).not.toContain("sk-")
  })

  it("merges editable custom provider metadata without requiring an API key", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        {
          name: "office-gateway",
          displayName: "Office Gateway",
          hasKey: false,
          active: false,
          custom: true,
          requiresApiKey: false,
        },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: [],
        envProviders: [],
      },
      settings: {
        customProviders: [
          {
            id: "office-gateway",
            displayName: "Office Gateway",
            baseUrl: "https://gateway.example/v1",
            apiFormat: "openai",
            models: [{
              id: "team-model",
              displayName: "Team Model",
              imageInputSupport: "native",
            }],
            headers: { "X-Tenant": "desktop" },
          },
        ],
      },
      models: [
        {
          name: "office-gateway",
          displayName: "Office Gateway",
          models: [
            {
              id: "team-model",
              label: "Team Model",
              provider: "Office Gateway",
              providerName: "office-gateway",
              inputCapabilities: { image: "native" },
            },
          ],
        },
      ],
    })

    expect(snapshot.providers[0]).toMatchObject({
      custom: true,
      connected: true,
      credentialSource: "configured",
      baseUrl: "https://gateway.example/v1",
      headers: { "X-Tenant": "desktop" },
      models: [{
        id: "team-model",
        label: "Team Model",
        imageInputSupport: "native",
      }],
    })
  })

  it("treats models.dev providers as credential-backed catalog connections", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        {
          name: "remote",
          displayName: "Remote AI",
          hasKey: true,
          active: false,
          source: "catalog",
        },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: ["remote"],
        envProviders: [],
      },
      settings: {
        customProviders: [
          {
            id: "remote",
            displayName: "Remote AI",
            baseUrl: "https://remote.example/v1",
            apiFormat: "openai",
            source: "models.dev",
            models: [{ id: "remote-chat", displayName: "Remote Chat" }],
            headers: { "X-Workspace": "team-a" },
          },
        ],
      },
      models: [
        {
          name: "remote",
          displayName: "Remote AI",
          models: [
            {
              id: "remote-chat",
              label: "Remote Chat",
              provider: "Remote AI",
              providerName: "remote",
            },
          ],
        },
      ],
    })

    expect(snapshot.providers[0]).toMatchObject({
      source: "catalog",
      connected: true,
      credentialSource: "credentials",
      headers: { "X-Workspace": "team-a" },
      models: [{ id: "remote-chat", label: "Remote Chat" }],
    })
    expect(snapshot.providers[0]).not.toHaveProperty("custom")
  })

  it("requires both catalog snapshot and credential to report connected", () => {
    const withoutSnapshot = buildDesktopProviderSnapshot({
      providers: [{
        name: "remote",
        displayName: "Remote",
        hasKey: true,
        active: false,
        source: "catalog",
      }],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: ["remote"],
        envProviders: [],
      },
      settings: { customProviders: [] },
      models: [],
    })

    expect(withoutSnapshot.providers[0]).toMatchObject({
      connected: false,
      credentialSource: "none",
    })
  })

  it("keeps true custom providers without API key as configured", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [{
        name: "office-gateway",
        displayName: "Office Gateway",
        hasKey: false,
        active: false,
        custom: true,
        requiresApiKey: false,
      }],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: [],
        envProviders: [],
      },
      settings: {
        customProviders: [{
          id: "office-gateway",
          displayName: "Office Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai",
          models: [{ id: "team-model", displayName: "Team Model" }],
        }],
      },
      models: [],
    })

    expect(snapshot.providers[0]).toMatchObject({
      custom: true,
      connected: true,
      credentialSource: "configured",
    })
  })

  it("does not treat Codex as connected when external auth is missing", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [{ name: "codex", displayName: "Codex Subscription", hasKey: true, active: true }],
      auth: {
        codex: {
          configured: false,
          state: "missing",
          source: "C:/Users/test/.codex/auth.json",
        },
        storedProviders: [],
        envProviders: [],
      },
      settings: { provider: "codex", model: "gpt-5.4" },
      models: [],
    })

    expect(snapshot.providers[0]).toMatchObject({
      connected: false,
      credentialSource: "none",
      active: true,
    })
    expect(snapshot).not.toHaveProperty("subscriptions")
  })

  it("uses the resolved runtime selection so provider snapshot matches bootstrap fallback", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
        { name: "gemini", displayName: "Gemini", hasKey: true, active: false },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: ["openai", "gemini"],
        envProviders: [],
      },
      settings: { provider: "gemini", model: "gpt-5.4" },
      models: [
        {
          name: "openai",
          displayName: "OpenAI",
          models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI", providerName: "openai" }],
        },
        {
          name: "gemini",
          displayName: "Gemini",
          models: [
            {
              id: "gemini-2.5-pro",
              label: "Gemini 2.5 Pro",
              provider: "Gemini",
              providerName: "gemini",
            },
          ],
        },
      ],
    })

    expect(snapshot.activeProvider).toBe("gemini")
    expect(snapshot.activeModel).toBe("gemini-2.5-pro")
    expect(snapshot.providers.find((item) => item.name === "gemini")).toMatchObject({
      active: true,
      currentModel: "gemini-2.5-pro",
    })
    expect(snapshot.providers.find((item) => item.name === "openai")).toMatchObject({
      active: false,
    })
  })

  it("does not keep built-in providers connected when auth cannot attribute a source", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [{ name: "deepseek", displayName: "DeepSeek", hasKey: true, active: false }],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: [],
        envProviders: [],
      },
      settings: {},
      models: [],
    })

    expect(snapshot.providers[0]).toMatchObject({
      connected: false,
      credentialSource: "none",
    })
  })
})

describe("DesktopProviderService catalog headers", () => {
  const service = new DesktopProviderService()

  const authMissing = {
    codex: { configured: false, state: "missing" as const, source: "none" },
    storedProviders: [] as string[],
    envProviders: [] as Array<{ name: string; envKey: string }>,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    daemon.providers.listProviders.mockResolvedValue([])
    daemon.auth.getStatus.mockResolvedValue(authMissing)
    daemon.system.getSettings.mockResolvedValue({})
    daemon.providers.listModels.mockResolvedValue([])
    daemon.providers.connectCatalogProvider.mockResolvedValue({
      name: "remote",
      displayName: "Remote",
      hasKey: true,
      active: false,
      source: "catalog",
    })
    daemon.providers.updateCatalogProviderHeaders.mockResolvedValue({
      name: "remote",
      displayName: "Remote",
      hasKey: true,
      active: false,
      source: "catalog",
    })
    daemon.auth.login.mockResolvedValue({
      name: "openai",
      displayName: "OpenAI",
      hasKey: true,
      active: false,
    })
  })

  it("detaches an old default provider before disconnecting its credential", async () => {
    daemon.system.getSettings.mockResolvedValue({ provider: "openai" })
    daemon.system.patchSettings.mockResolvedValue({})
    await service.disconnect({ provider: "openai" })
    expect(daemon.system.patchSettings).toHaveBeenCalledWith({ provider: "auto" })
    expect(daemon.auth.logout).toHaveBeenCalledWith({ provider: "openai" })
  })

  it("detaches an old default custom provider before removing its connection", async () => {
    daemon.system.getSettings.mockResolvedValue({ provider: "office-gateway" })
    daemon.system.patchSettings.mockResolvedValue({})
    daemon.providers.removeCustomProvider.mockResolvedValue({})
    await service.removeCustom({ provider: "office-gateway" })
    expect(daemon.system.patchSettings).toHaveBeenCalledWith({ provider: "auto" })
    expect(daemon.providers.removeCustomProvider).toHaveBeenCalledWith("office-gateway")
  })


  it("forwards catalog connect header templates to the client", async () => {
    daemon.providers.listProviders.mockResolvedValue([
      {
        name: "remote",
        displayName: "Remote",
        hasKey: false,
        active: false,
        source: "catalog",
      },
    ])
    daemon.auth.getStatus.mockResolvedValue({
      ...authMissing,
      storedProviders: ["remote"],
    })
    daemon.system.getSettings.mockResolvedValue({
      customProviders: [{
        id: "remote",
        displayName: "Remote",
        baseUrl: "https://remote.example/v1",
        apiFormat: "openai",
        source: "models.dev",
        models: [{ id: "remote-chat", displayName: "Remote Chat" }],
        headers: { "X-Workspace": "team-a" },
      }],
    })

    await service.connect({
      provider: "remote",
      apiKey: "catalog-secret",
      headers: { "X-Workspace": "team-a" },
    })

    expect(daemon.providers.connectCatalogProvider).toHaveBeenCalledWith("remote", {
      apiKey: "catalog-secret",
      headers: { "X-Workspace": "team-a" },
    })
    expect(daemon.auth.login).not.toHaveBeenCalled()
  })

  it("keeps built-in connect on authLogin and ignores headers", async () => {
    daemon.providers.listProviders.mockResolvedValue([
      { name: "openai", displayName: "OpenAI", hasKey: false, active: false },
    ])
    daemon.auth.getStatus.mockResolvedValue({
      ...authMissing,
      storedProviders: ["openai"],
    })

    await service.connect({
      provider: "openai",
      apiKey: "sk-test",
      headers: { "X-Ignored": "nope" },
    })

    expect(daemon.auth.login).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: "sk-test",
    })
    expect(daemon.providers.connectCatalogProvider).not.toHaveBeenCalled()
  })

  it("routes updateCatalogHeaders only through the catalog client method", async () => {
    daemon.providers.listProviders.mockResolvedValue([
      {
        name: "remote",
        displayName: "Remote",
        hasKey: true,
        active: false,
        source: "catalog",
      },
    ])
    daemon.auth.getStatus.mockResolvedValue({
      ...authMissing,
      storedProviders: ["remote"],
    })
    daemon.system.getSettings.mockResolvedValue({
      customProviders: [{
        id: "remote",
        displayName: "Remote",
        baseUrl: "https://remote.example/v1",
        apiFormat: "openai",
        source: "models.dev",
        models: [{ id: "remote-chat", displayName: "Remote Chat" }],
        headers: { "X-Workspace": "team-b" },
      }],
    })

    const snapshot = await service.updateCatalogHeaders({
      provider: "remote",
      headers: { "X-Workspace": "team-b" },
    })

    expect(daemon.providers.updateCatalogProviderHeaders).toHaveBeenCalledWith("remote", {
      "X-Workspace": "team-b",
    })
    expect(daemon.providers.connectCatalogProvider).not.toHaveBeenCalled()
    expect(daemon.auth.login).not.toHaveBeenCalled()
    expect(snapshot.providers[0]).toMatchObject({
      source: "catalog",
      connected: true,
      headers: { "X-Workspace": "team-b" },
    })
  })
})
