# @vykor/core

Core engine for Vykor query execution, tool registration, history and compaction.

## 功能

- **QueryEngine**: 流式 LLM 调用 + 工具执行循环
- **ToolRegistry**: 工具注册表
- **CompactService**: 双层压缩服务

## 使用

```ts
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { loadSettings } from "@vykor/host-config";
import type { Message, UsageSnapshot } from "@vykor/agent-contracts";
```

## API

公共消息、用量和错误类型由 `agent-contracts` 定义；本机配置的类型、路径、读取与保存由 `host-config` 提供。

### QueryEngine

- `QueryEngine` - LLM 查询引擎
- `streamQuery(params)` - 流式查询

### ToolRegistry

- `register(tool)` - 注册工具
- `get(name)` - 获取工具
- `getAll()` - 获取所有工具

## 测试

```bash
pnpm --filter @vykor/core test
```
