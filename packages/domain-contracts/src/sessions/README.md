# 会话、运行与消息记录

定义项目、会话、输入、消息片段、执行记录和事件等共用数据，也提供安全读取运行配置及模型元数据的函数。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/sessions` 汇总入口 |
| [records.ts](records.ts) | 记录类型、事件版本和默认存储方式 |
| [model-metadata.ts](model-metadata.ts) | 读取重试、生成归属、用量完整性，以及收尾工具元数据 |
| [runtime-config.ts](runtime-config.ts) | 运行配置类型、`metadata.runtime` 校验与版本读取 |
| [event-scope.ts](event-scope.ts) | 历史查询和实时订阅共用的会话范围匹配，全局事件对所有会话可见 |

另有 `@vykor/domain-contracts/sessions/records`、`sessions/model-metadata`、`sessions/runtime-config` 公开入口。调用方按类型读写记录，读取模型片段时用 `isCommittedModelPart` 排除未确认或已被替代的内容，读取配置时用 `readRuntimeMetadata` 验证字段。

本目录不运行 Agent，也不打开 SQLite。会话状态、运行记录和配置版本由消费方管理，函数只返回读取或整理后的数据。新增会话契约放本目录，测试建议放同层 `__test__/`。

`SessionRuntimeConfig.replyStyle` 接受 `collaborative`、`direct`、`explanatory` 或 `inherit`。前三项保存会话自己的回复偏好，`inherit` 明确恢复跟随当前全局设置；`readRuntimeMetadata` 在保存前拒绝其他值。
