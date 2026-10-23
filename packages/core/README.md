# @vykor/core

负责一次对话里的模型请求、工具执行、历史消息压缩和用量统计。调用方提供模型客户端、工具、权限检查和运行上下文，core 将处理结果以事件流返回。用量中的 token 是模型计量内容长度的单位。

## 目录导航

| 目录 | 职责 | 说明 |
| --- | --- | --- |
| `src/session/` | 为查询引擎绑定会话 ID，转发消息与历史操作 | [README](./src/session/README.md) |
| `src/engine/` | 组织一次提交中的模型与工具循环 | [README](./src/engine/README.md) |
| `src/engine/model/` | 模型请求、流式结果、重试和请求前检查 | [README](./src/engine/model/README.md) |
| `src/engine/tools/` | 工具注册、发现、参数检查、权限与执行 | [README](./src/engine/tools/README.md) |
| `src/engine/compaction/` | 清理旧工具输出、压缩历史、保留任务线索 | [README](./src/engine/compaction/README.md) |
| `src/engine/trajectory/` | 根据工具执行结果提示模型调整后续行动 | [README](./src/engine/trajectory/README.md) |
| `src/engine/usage/` | 累加实际模型请求的 token 用量 | [README](./src/engine/usage/README.md) |
| `src/context-budget/` | 估算上下文占用，生成分类报告与建议 | [README](./src/context-budget/README.md) |
| `src/types/` | 定义 core 的构造参数、请求配置和接口 | [README](./src/types/README.md) |
| `src/utils/` | 消息历史处理、文本 token 估算、通用重试 | [README](./src/utils/README.md) |
| `src/constants/` | 多个模块共用的固定估算值 | [README](./src/constants/README.md) |

## 一次提交如何运行

1. 调用 `AgentSession.submitMessage()` 或 `QueryEngine.submitMessage()`，传入用户内容和本次运行上下文。
2. `QueryEngine` 保存消息历史，按需压缩旧消息，确定本轮模型、提示词和可用工具。
3. `model/` 发起模型请求，逐步返回文本、推理内容、工具调用和用量；请求失败时按策略重试。
4. 模型要求调用工具时，`tools/` 检查参数和权限，执行工具，将结果交回引擎写入历史，再进入下一轮。
5. 模型完成回答或触发停止条件后，事件流结束；调用方可读取历史和累计用量。

消息历史由 `QueryEngine` 实例持有，工具定义由 `ToolRegistry` 实例持有；会话存储和运行生命周期由调用方管理。

## 公开入口

```ts
import { AgentSession, QueryEngine, ToolRegistry } from "@vykor/core";
import { RunToolDiscovery, runToolRegistry } from "@vykor/core/engine";
import { assembleContextUsageSnapshot } from "@vykor/core/context-budget";
```

`src/index.ts` 汇总公开 API；`src/engine/index.ts` 补充运行时使用的工具注册表与发现能力。跨包调用优先使用上述入口，避免直接引用内部文件。公共消息、事件和工具契约由 `@vykor/agent-contracts` 提供，本机配置由 `@vykor/host-config` 提供。

## 测试与维护

测试放在被测模块所属目录下的 `__test__/`，例如 `engine/tools/tool-input-schema.ts` 对应 `engine/tools/__test__/tool-input-schema.test.ts`。覆盖整个查询循环的测试放在 `engine/__test__/`。

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/core exec vitest run src/engine/tools/__test__
```

新增代码按职责放入相应目录，并更新该目录 README；只有需要供其他包调用的能力才从公开入口导出。
