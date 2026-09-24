# @vykor/api

LLM provider registry and streaming clients for Vykor.

## Features

- Provider registry with 21 built-in providers.
- Provider detection by key prefix, base URL keyword, model keyword, and
  provider-specific environment variables.
- `AnthropicClient` for Anthropic-native streaming.
- `OpenAICompatibleClient` for OpenAI-compatible APIs.
- `CodexSubscriptionClient` for Codex subscription routing through the local
  Codex auth source.

## Providers

Provider definitions live in `src/providers/registry.ts`.

Main groups:

| Group | Providers |
|---|---|
| Anthropic-native | `anthropic` |
| OpenAI-compatible | `openai`, `deepseek`, `gemini`, `dashscope`, `moonshot`, `minimax`, `zhipu`, `groq`, `mistral`, `stepfun`, `baidu`, `bedrock`, `vertex` |
| Gateways | `openrouter`, `aihubmix`, `siliconflow`, `volcengine` |
| Local | `ollama`, `vllm` |
| External subscription | `codex` |

Each provider records:

- `name`
- `keywords`
- `envKey`
- `displayName`
- `backendType`
- `defaultBaseURL`
- detection hints
- local/gateway/OAuth flags

## Runtime Selection

`resolveApiClient` in the CLI uses the selected provider to choose a backend:

```text
backendType === "anthropic"      -> AnthropicClient
backendType === "openai_compat"  -> OpenAICompatibleClient
backendType === "codex"          -> CodexSubscriptionClient
```

For Codex, the API package expects an access token as `ProviderConfig.apiKey`.
The auth package is responsible for loading that token from the local Codex CLI
auth file.

## Usage

```ts
import {
  AnthropicClient,
  OpenAICompatibleClient,
  CodexSubscriptionClient,
  detectProvider,
  findByName,
} from "@vykor/api";

const provider = detectProvider("deepseek-chat", undefined, undefined);

const deepseek = new OpenAICompatibleClient({
  apiKey: "sk-xxx",
  baseURL: provider?.defaultBaseURL,
  model: "deepseek-chat",
});

const codex = new CodexSubscriptionClient({
  apiKey: "codex-access-token",
  model: "gpt-5.4",
});
```

## Tests

```bash
pnpm --filter @vykor/api test
```
