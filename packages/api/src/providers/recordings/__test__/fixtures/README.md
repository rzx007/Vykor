# 真实供应商观测样本

[manifest.json](manifest.json) 列出必须存在的样本、文件摘要、实际观测结果和未配置路由。集成测试对 requiredRoutes 使用普通失败断言，没有 skip；文件缺失、摘要不符、source 不是 observed、请求不匹配都失败。

- [openai.observed.json](openai.observed.json)：2026-10-30 UTC，配置中的 tokenharbor / mimo-v2.5:free，一条公开 Echo 工具请求，HTTP 200；保留实际工具参数碎片、tool_calls stop 和 98 输入 / 21 输出 token 用量。
- [codex.observed.json](codex.observed.json)：2026-10-30 UTC，现有 Codex 登录，实际 CodexSubscriptionClient / gpt-5.6-sol 一条公开短文本请求，HTTP 200；27 输入 / 7 输出 token，含真实 response.metadata 未知事件。客户端未发送输出 token 上限，采集使用 45 秒与 64 KiB 传输预算。

两条样本均为真实网络边界观察，每条一次成功请求，没有追加轮次。只发送固定公开内容 public-probe；请求头及响应主机未保存，未提交用户文件、个人路径或私人会话。显式秘密替换及内置检测在写盘前运行；样本保留供应商事件结构、关联 ID、时间和 usage，网络传输分块合并为确定性的文本块。清单摘要针对脱敏文件，未保存原始秘密或原始流文件。

Anthropic 原生真实录制目前未取得：环境无 Anthropic key，实际凭据存储无 anthropic 项，主路由为 OpenAI 格式，没有 native Anthropic 自定义路由或 profile 路由。既有 Anthropic 构造解码测试继续存在，但不算这里的真实覆盖。当前代码没有 WebSocket 客户端，故不声明 WS 覆盖。

入口是[集成回放测试](../../../../../../../../tests/agent-integration/provider-recording-replay.integration.test.ts)；读取清单和文件后，为每次回放创建独立消费位置，比较实际客户端请求，读取全部响应并检查已消费，再比较整块与逐字节传输时的完整事件结果。另有明确标为 synthetic 的中文 UTF-8 边界测试，它不是供应商真实样本。新增样本必须重新真实观测，不能用手写事件填充缺失路由。
