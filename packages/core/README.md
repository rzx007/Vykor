# @vykor/core

Core engine for Vykor query execution, settings management, and tool registry.

## 功能

- **QueryEngine**: 流式 LLM 调用 + 工具执行循环
- **Settings**: 配置管理 (load/save)
- **ToolRegistry**: 工具注册表
- **CompactService**: 双层压缩服务

## 使用

```ts
import { QueryEngine, loadSettings, ToolRegistry } from "@vykor/core";
```

## API

### Settings

- `loadSettings(cwd?)` - 加载配置
- `saveSettings(settings)` - 保存配置

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