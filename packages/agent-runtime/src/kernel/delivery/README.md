# 结构化交付

宿主需要固定格式的结果时，通过 `AgentOutputContract` 配置 `schema` 和可选的 `verify`。`FrameworkAgentRun` 为本轮加入 `SubmitResult`，普通聊天仍走原来的文本输出。

| 文件 | 用途 |
| --- | --- |
| `schema.ts` | 检查 Schema 支持范围与 JSON 数据，拒绝未支持的约束 |
| `structured-delivery.ts` | 创建本轮提交工具，先检查结构和宿主核验，再保存交付回执 |
| `__test__/` | 格式、业务核验、纠错、取消与实际模型循环测试 |

调用流程：模型完成实际工作 → 单独调用 `SubmitResult` → 检查 `status`、`summary`、`data` → 在工具派发前调用宿主核验器 → 成功后保存本轮回执并结束查询 → 从 `AgentRunResult.delivery` 和 `run.completed.data.delivery` 返回。回执只存在当前运行对象中；Server 把完成回执写入已有 Run 的 metadata。取消和超时仍由原工具执行管道处理。

`validation: schema_valid` 只说明数据符合格式。配置了宿主核验器且返回 `ok: true` 才标为 `verification: passed`；没有核验器则为 `not_requested`。`done`、`partial`、`blocked`、`waiting` 是交付进展，Run 正常结束不会自动完成 Goal。

Schema 使用现有工具校验器支持的子集：`type`、`properties`、`required`、布尔 `additionalProperties`、单一 `items`、基本值 `enum`/`const`、数值 `minimum`/`maximum`、字符串 `minLength`/`maxLength` 及 `title`/`description`。不支持的关键字在配置时直接报错；不声明兼容完整 JSON Schema。Schema 最多 512 个节点、16 层，HTTP 请求额外限制为 64 KiB。

新增格式限制与 JSON 检查放 `schema.ts`，交付状态规则放 `structured-delivery.ts`。文件、数据库和业务验收由宿主 `verify` 读取当前事实完成，不放进执行核心。默认子 Agent 不继承根任务的输出格式；子工厂可为它显式配置自己的合同。
