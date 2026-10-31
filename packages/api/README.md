# @vykor/api

把 Anthropic、OpenAI 兼容接口和本地 Codex 订阅接口的响应转换成统一的消息流，并提供服务商识别、模型目录、请求头和错误转换。

## 目录导航

- [src/](src/README.md)：公开导出及请求流程。
- [src/providers/](src/providers/README.md)：服务商注册表和三类流式客户端。
- [src/providers/tools/](src/providers/tools/README.md)：工具参数解析、生成进度和异常格式恢复。
- [src/providers/media/](src/providers/media/README.md)：图片读取、压缩和请求内容转换。
- [src/providers/requests/](src/providers/requests/README.md)：请求头模板、取消和超时。
- [src/providers/streaming/](src/providers/streaming/README.md)：思考块拆分和 token 用量整理。
- [src/providers/recordings/](src/providers/recordings/README.md)：真实 HTTP 样本的脱敏、来源清单和离线回放。
- [src/models/](src/models/README.md)：模型列表、缓存和可直接使用 API Key 的服务商筛选。
- [src/errors/](src/errors/README.md)：把服务商错误转换为统一失败信息。

## 入口与运行过程

唯一包入口是 [src/index.ts](src/index.ts)。调用方用 `findByName` / `detectProvider` / `detectProviderFromEnv` 选择服务商，再按 `backendType` 创建 `AnthropicClient`、`OpenAICompatibleClient` 或 `CodexSubscriptionClient`。先用 `prepareUserContent` 准备图片内容，再用 `streamMessage` 读取统一事件。

注册表支持原生 Anthropic、OpenAI 兼容服务商、网关、本地服务和 Codex 订阅路由，具体名称及检测规则以 [registry.ts](src/providers/registry.ts) 为准。`ProviderConfig.apiKey` 由调用方提供；Codex 需要的是从本地 Codex 登录源读取的访问令牌，读取工作属于 `@vykor/auth`。

```ts
import { CODEX_DEFAULT_MODEL, CodexSubscriptionClient, findByName } from "@vykor/api";

const provider = findByName("codex");
const client = new CodexSubscriptionClient({
  apiKey: "codex-access-token",
  baseURL: provider?.defaultBaseURL,
  model: CODEX_DEFAULT_MODEL,
});
```

客户端保存连接配置；每次请求的消息、工具参数和流状态归该请求。模型目录服务维护内存及配置目录下的缓存，图片准备器维护有上限的内存缓存。认证文件由 auth 包管理。

## 新增代码与检查

新增服务商接入放 `src/providers/`，共用处理放对应子分类；模型数据与错误映射分别放 models 和 errors。测试放被测分类的 `__test__/`，跨 providers 子分类的客户端行为放 `src/providers/__test__/`。

```bash
pnpm --filter @vykor/api test
pnpm --filter @vykor/api check-types
```
