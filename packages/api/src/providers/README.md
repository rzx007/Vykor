# 模型服务商接入

维护服务商识别和三种响应协议，把不同接口的消息流整理为同一种事件。

## 主要文件

- [registry.ts](registry.ts)：服务商定义、检测规则、地址和输入能力。
- [anthropic.ts](anthropic.ts)：Anthropic 原生消息流。
- [openai.ts](openai.ts)：OpenAI 兼容聊天接口。
- [codex.ts](codex.ts)：Codex 订阅 HTTP 流与请求头。
- [recordings/](recordings/README.md)：真实供应商 HTTP 观测、脱敏和无网络回放。

## 调用与状态

公开入口从 [../index.ts](../index.ts) 导入 `findByName`、`detectProvider`、`detectProviderFromEnv` 和三个客户端；`resolveProviderScopedBaseUrl` 解析当前服务商的地址。

上层按注册表的 `backendType` 选择客户端。客户端准备内容、建立请求、逐段解析文本与工具调用，最后返回统一的事件和用量；具体辅助处理见 [tools](tools/README.md)、[media](media/README.md)、[requests](requests/README.md)、[streaming](streaming/README.md)。

客户端实例持有配置和 SDK 客户端；响应缓冲、工具参数和生成进度只属于一次 `streamMessage` 调用。凭据由调用方传入。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
