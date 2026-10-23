# 插件应用数据契约

定义插件应用实例、动作、会话提交及其校验边界，供宿主和通信适配层使用。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/plugin-apps` 公开入口 |
| [records.ts](records.ts) | 当前插件应用记录、动作元数据和回执，及动作元数据读取 |
| [validation.ts](validation.ts) | 打开、关闭、工具调用、会话提交及输入框上下文的校验 |
| [limits.ts](limits.ts) | 交接数据大小、消息字符数和输入框上下文数量上限 |
| [history.ts](history.ts) | 只读解析既有旧插件 UI 历史数据中的实例、动作和提交回执 |

`@vykor/domain-contracts/plugin-apps/history` 直接公开历史读取定义。旧 UI 模块只用于读取已有历史数据，不用于创建新 UI、发起动作或恢复旧 UI 执行能力。

当前请求交给 `validatePluginApp*` 函数，检查字段、版本、数据大小和运行凭据形状，返回 `{ ok, value }` 或错误码。`readPluginAppAction` 读取宿主保存的动作元数据。这些函数只检查数据；消费方仍需核对实际所属会话、插件与运行凭据。

应用实例、当前版本、运行凭据和动作执行状态由消费方管理，本目录不启动后端或调用工具。新增当前应用契约放 `records.ts`、`validation.ts`，相关测试建议放同层 `__test__/`；旧历史读取内容保留在 `history.ts`。
