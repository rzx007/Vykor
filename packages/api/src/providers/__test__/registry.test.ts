import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  detectProvider,
  detectProviderFromEnv,
  findByName,
  resolveProviderScopedBaseUrl,
  providerInputCapabilities,
} from "../registry.js";

describe("PROVIDERS", () => {
  it("declares the image request formats each adapter can construct", () => {
    expect(providerInputCapabilities("openai_compat")).toEqual({
      image: "native",
      imageMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    });
    expect(providerInputCapabilities("codex")).toEqual({
      image: "native",
      imageMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    });
    expect(providerInputCapabilities("anthropic")).toEqual({
      image: "native",
      imageMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    });
  });

  it("does not advertise local services that were not detected", () => {
    const names = PROVIDERS.map((provider) => provider.name);
    expect(names).not.toContain("ollama");
    expect(names).not.toContain("vllm");
  });

  it("each provider has required fields", () => {
    for (const p of PROVIDERS) {
      expect(p.name).toBeTruthy();
      expect(p.keywords).toBeInstanceOf(Array);
      expect(p.backendType).toBeDefined();
      expect(p.displayName).toBeTruthy();
      expect(typeof p.isGateway).toBe("boolean");
      expect(typeof p.isLocal).toBe("boolean");
      expect(typeof p.isOAuth).toBe("boolean");
    }
  });

  it("anthropic is listed", () => {
    const a = findByName("anthropic");
    expect(a).toBeDefined();
    expect(a!.backendType).toBe("anthropic");
    expect(a!.envKey).toBe("ANTHROPIC_API_KEY");
  });

  it("openai is listed", () => {
    const o = findByName("openai");
    expect(o).toBeDefined();
    expect(o!.backendType).toBe("openai_compat");
  });

  it("codex subscription is listed", () => {
    const c = findByName("codex");
    expect(c).toBeDefined();
    expect(c!.backendType).toBe("codex");
    expect(c!.isOAuth).toBe(true);
  });

  it("openrouter is gateway", () => {
    const o = findByName("openrouter");
    expect(o).toBeDefined();
    expect(o!.isGateway).toBe(true);
    expect(o!.detectByKeyPrefix).toBe("sk-or-");
  });

  it("chinese providers are listed", () => {
    const names = PROVIDERS.map((p) => p.name);
    expect(names).toContain("dashscope");
    expect(names).toContain("deepseek");
    expect(names).toContain("moonshot");
    expect(names).toContain("minimax");
    expect(names).toContain("zhipu");
    expect(names).toContain("stepfun");
    expect(names).toContain("baidu");
    expect(names).toContain("siliconflow");
    expect(names).toContain("volcengine");
  });
});

describe("findByName", () => {
  it("finds existing provider", () => {
    expect(findByName("groq")).toBeDefined();
    expect(findByName("groq")!.displayName).toBe("Groq");
  });

  it("returns undefined for unknown", () => {
    expect(findByName("nonexistent")).toBeUndefined();
  });
});

describe("detectProvider", () => {
  it("detects by api key prefix (openrouter)", () => {
    const result = detectProvider("some-model", "sk-or-12345");
    expect(result).toBeDefined();
    expect(result!.name).toBe("openrouter");
  });

  it("detects by api key prefix (groq)", () => {
    const result = detectProvider("some-model", "gsk_abc123");
    expect(result).toBeDefined();
    expect(result!.name).toBe("groq");
  });

  it("detects by base url keyword", () => {
    const result = detectProvider("some-model", "sk-xxx", "https://aihubmix.com/v1");
    expect(result).toBeDefined();
    expect(result!.name).toBe("aihubmix");
  });

  it("detects by base url keyword (dashscope)", () => {
    const result = detectProvider("model", undefined, "https://dashscope.aliyuncs.com");
    expect(result).toBeDefined();
    expect(result!.name).toBe("dashscope");
  });

  it("detects codex by chatgpt backend base url", () => {
    const result = detectProvider("gpt-5.4", undefined, "https://chatgpt.com/backend-api");
    expect(result).toBeDefined();
    expect(result!.name).toBe("codex");
  });

  it("detects by model keyword (claude)", () => {
    const result = detectProvider("claude-sonnet-4-20250514");
    expect(result).toBeDefined();
    expect(result!.name).toBe("anthropic");
  });

  it("detects by model keyword (gpt)", () => {
    const result = detectProvider("gpt-4o");
    expect(result).toBeDefined();
    expect(result!.name).toBe("openai");
  });

  it("detects by model keyword (deepseek)", () => {
    const result = detectProvider("deepseek-chat");
    expect(result).toBeDefined();
    expect(result!.name).toBe("deepseek");
  });

  it("detects by model keyword (qwen)", () => {
    const result = detectProvider("qwen-max");
    expect(result).toBeDefined();
    expect(result!.name).toBe("dashscope");
  });

  it("detects by model prefix (deepseek/deepseek-chat)", () => {
    const result = detectProvider("deepseek/deepseek-chat");
    expect(result).toBeDefined();
    expect(result!.name).toBe("deepseek");
  });

  it("detects by model keyword (gemini)", () => {
    const result = detectProvider("gemini-pro");
    expect(result).toBeDefined();
    expect(result!.name).toBe("gemini");
  });

  it("returns undefined for unrecognized", () => {
    const result = detectProvider("unknown-model-xyz");
    expect(result).toBeUndefined();
  });

  it("prioritizes key prefix over base url", () => {
    const result = detectProvider("model", "sk-or-xxx", "https://dashscope.aliyuncs.com");
    expect(result!.name).toBe("openrouter");
  });

  it("prioritizes base url over model keyword", () => {
    const result = detectProvider("claude-3", undefined, "https://api.groq.com/openai/v1");
    expect(result!.name).toBe("groq");
  });
});

describe("detectProviderFromEnv", () => {
  it("detects anthropic from ANTHROPIC_API_KEY", () => {
    const result = detectProviderFromEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(result).toBeDefined();
    expect(result!.name).toBe("anthropic");
  });

  it("detects openai from OPENAI_API_KEY", () => {
    const result = detectProviderFromEnv({ OPENAI_API_KEY: "sk-test" });
    expect(result).toBeDefined();
    expect(result!.name).toBe("openai");
  });

  it("detects deepseek from DEEPSEEK_API_KEY", () => {
    const result = detectProviderFromEnv({ DEEPSEEK_API_KEY: "dsk-test" });
    expect(result).toBeDefined();
    expect(result!.name).toBe("deepseek");
  });

  it("returns undefined when no keys present", () => {
    const result = detectProviderFromEnv({});
    expect(result).toBeUndefined();
  });

});

describe("resolveProviderScopedBaseUrl", () => {
  it("drops a base URL owned by another provider", () => {
    expect(
      resolveProviderScopedBaseUrl("https://open.bigmodel.cn/api/paas/v4", "codex"),
    ).toBeUndefined();
  });

  it("keeps custom base URLs without a known provider marker", () => {
    expect(
      resolveProviderScopedBaseUrl("https://custom.example/v1", "openai"),
    ).toBe("https://custom.example/v1");
  });
});
