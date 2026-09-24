# 自定义供应商设计说明

## 目标

移除静态注册表中写死的 Ollama 与 vLLM 项，改为允许用户保存多个 OpenAI 兼容供应商。自定义供应商必须与内置供应商出现在同一列表，并真实参与凭证、模型选择和运行时请求，不执行 `vk auth` 或 `vk provider` 命令。

## 数据模型

`Settings.customProviders` 保存非敏感配置：

```ts
interface CustomProviderSettings {
  id: string
  displayName: string
  baseUrl: string
  apiFormat: "openai"
  models: Array<{ id: string; displayName: string }>
  headers?: Record<string, string>
}
```

API Key 继续通过 `CredentialStorage` 按供应商 ID 单独保存，不进入普通设置文件。供应商 ID 使用小写字母、数字、连字符或下划线，且不能与内置供应商重名。Base URL 必须是 `http:` 或 `https:` URL；至少配置一个模型，模型 ID 不得重复；请求头名称和值会去除首尾空白，空行不会保存。

## 运行流程

1. Desktop 表单提交自定义供应商配置与可选 API Key。
2. main 进程通过现有 client 调用 daemon 资源接口：设置保存非敏感配置，auth 服务保存可选 API Key。
3. daemon 的供应商服务将内置注册表与 `customProviders` 合并；模型服务将自定义模型合并到模型目录结果中。
4. 用户设为当前后，设置写入 `provider`、`model`、`baseUrl` 与 `apiFormat`。
5. agent runtime 按当前 provider ID 查找 `customProviders`，创建 OpenAI 兼容客户端并传入 Base URL 与请求头。

## Desktop 交互

- 自定义供应商入口仍位于供应商统一列表的末尾，以正常可用的“添加”按钮展示。
- 添加和编辑使用同一个 Dialog，字段包含供应商 ID、显示名称、Base URL、可选 API Key、动态模型行、动态请求头行。
- 已保存的自定义项使用与内置项相同的 ProviderRow；通过更多操作提供“编辑”和“删除”。
- 当前供应商不可删除；删除非当前供应商前使用 AlertDialog 二次确认，并清理对应凭证。
- API Key 为空时允许保存，卡片显示为“无需密钥”；用户之后可以编辑并补充密钥。
- 所有变更操作共用全局 busy 锁，Alert 按既有逻辑自动消失。

## 兼容性与边界

- 第一版只支持 OpenAI 兼容 API，不提供 Anthropic 自定义协议。
- 移除 Ollama、vLLM 的注册表项、固定描述、自动本地已连接判断和相关测试断言。
- 已有配置中若 `provider` 恰为 `ollama` 或 `vllm`，不会伪造自定义配置；用户需要在设置页重新添加实际端点。
- 不新增外部依赖，不改变设置页可调整左右布局和右侧圆角阴影容器。

