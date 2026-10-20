import type { ComponentType, SVGProps } from "react"

import AiHubMixColor from "@lobehub/icons/es/AiHubMix/components/Color"
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono"
import BaiduColor from "@lobehub/icons/es/Baidu/components/Color"
import BailianColor from "@lobehub/icons/es/Bailian/components/Color"
import BedrockColor from "@lobehub/icons/es/Bedrock/components/Color"
import CodexColor from "@lobehub/icons/es/Codex/components/Color"
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color"
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color"
import GroqMono from "@lobehub/icons/es/Groq/components/Mono"
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color"
import MistralColor from "@lobehub/icons/es/Mistral/components/Color"
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono"
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono"
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono"
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color"
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color"
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono"
import VertexAIColor from "@lobehub/icons/es/VertexAI/components/Color"
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color"
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color"

import { createProviderBrandIconResolver } from "./provider-icon"

export type ProviderBrandIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>

export const resolveProviderBrandIcon = createProviderBrandIconResolver<ProviderBrandIcon>({
  aiHubMix: AiHubMixColor,
  anthropic: AnthropicMono,
  baidu: BaiduColor,
  bailian: BailianColor,
  bedrock: BedrockColor,
  codex: CodexColor,
  deepSeek: DeepSeekColor,
  gemini: GeminiColor,
  groq: GroqMono,
  minimax: MinimaxColor,
  mistral: MistralColor,
  moonshot: MoonshotMono,
  openAI: OpenAIMono,
  openCode: OpenCodeMono,
  openRouter: OpenRouterColor,
  siliconCloud: SiliconCloudColor,
  stepfun: StepfunMono,
  vertexAI: VertexAIColor,
  volcengine: VolcengineColor,
  zhiPu: ZhipuColor,
})
