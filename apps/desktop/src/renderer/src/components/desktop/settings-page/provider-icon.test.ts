import { describe, expect, it } from "vitest"

import { createProviderBrandIconResolver } from "./provider-icon"

const icons = {
  aiHubMix: Symbol("AiHubMix"),
  anthropic: Symbol("Anthropic"),
  baidu: Symbol("Baidu"),
  bailian: Symbol("Bailian"),
  bedrock: Symbol("Bedrock"),
  codex: Symbol("Codex"),
  deepSeek: Symbol("DeepSeek"),
  gemini: Symbol("Gemini"),
  groq: Symbol("Groq"),
  minimax: Symbol("Minimax"),
  mistral: Symbol("Mistral"),
  moonshot: Symbol("Moonshot"),
  openAI: Symbol("OpenAI"),
  openCode: Symbol("OpenCode"),
  openRouter: Symbol("OpenRouter"),
  siliconCloud: Symbol("SiliconCloud"),
  stepfun: Symbol("Stepfun"),
  vertexAI: Symbol("VertexAI"),
  volcengine: Symbol("Volcengine"),
  zhiPu: Symbol("ZhiPu"),
}

const resolveProviderBrandIcon = createProviderBrandIconResolver(icons)

describe("resolveProviderBrandIcon", () => {
  it.each([
    ["openai", icons.openAI],
    ["codex", icons.codex],
    ["dashscope", icons.bailian],
    ["siliconflow", icons.siliconCloud],
    ["bedrock", icons.bedrock],
    ["vertex", icons.vertexAI],
    ["zhipu", icons.zhiPu],
    ["zhipuai-coding-plan", icons.zhiPu],
  ])("matches the %s provider to its Lobe icon", (provider, expected) => {
    expect(resolveProviderBrandIcon(provider)).toBe(expected)
  })

  it("normalizes provider IDs before matching", () => {
    expect(resolveProviderBrandIcon("  OpenAI  ")).toBe(icons.openAI)
  })
  it.each([
    "opencode",
    "opencode-go",
    "opencode-zen",
    "OpenCode Go",
    "OpenCode Zen",
    "  OPENCODE_ZEN  ",
  ])("matches %s to the OpenCode brand", (provider) => {
    expect(resolveProviderBrandIcon(provider)).toBe(icons.openCode)
  })
  it.each(["opencode-proxy", "my-opencode-gateway"])(
    "does not guess the brand of a custom gateway %s",
    (provider) => {
      expect(resolveProviderBrandIcon(provider)).toBeUndefined()
    }
  )

  it("leaves unmatched custom providers for the generic fallback", () => {
    expect(resolveProviderBrandIcon("office-gateway")).toBeUndefined()
  })
})
