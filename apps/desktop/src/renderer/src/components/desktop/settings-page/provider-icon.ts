export interface ProviderBrandIcons<T> {
  aiHubMix: T
  anthropic: T
  baidu: T
  bailian: T
  bedrock: T
  codex: T
  deepSeek: T
  gemini: T
  groq: T
  minimax: T
  mistral: T
  moonshot: T
  openAI: T
  openCode: T
  openRouter: T
  siliconCloud: T
  stepfun: T
  vertexAI: T
  volcengine: T
  zhiPu: T
}

export function createProviderBrandIconResolver<T>(
  icons: ProviderBrandIcons<T>
): (provider: string) => T | undefined {
  const iconsByProvider = new Map<string, T>([
    ["aihubmix", icons.aiHubMix],
    ["anthropic", icons.anthropic],
    ["baidu", icons.baidu],
    ["dashscope", icons.bailian],
    ["bedrock", icons.bedrock],
    ["codex", icons.codex],
    ["deepseek", icons.deepSeek],
    ["gemini", icons.gemini],
    ["groq", icons.groq],
    ["minimax", icons.minimax],
    ["mistral", icons.mistral],
    ["moonshot", icons.moonshot],
    ["openai", icons.openAI],
    ["opencode", icons.openCode],
    ["opencode-go", icons.openCode],
    ["opencode-zen", icons.openCode],
    ["openrouter", icons.openRouter],
    ["siliconflow", icons.siliconCloud],
    ["stepfun", icons.stepfun],
    ["vertex", icons.vertexAI],
    ["volcengine", icons.volcengine],
    ["zhipu", icons.zhiPu],
    ["zhipuai", icons.zhiPu],
    ["zhipuai-coding-plan", icons.zhiPu],
    ["zai", icons.zhiPu],
    ["zai-coding-plan", icons.zhiPu],
  ])

  return (provider) =>
    iconsByProvider.get(
      provider
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
    )
}
