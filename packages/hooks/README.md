# @vykor/hooks

Hook execution system for before/after LLM queries.

## 功能

- **HookRegistry**: 钩子注册表
- **executeHook()**: 同步/异步钩子执行
- **register()**: last-writer-wins 注册

## Hook 类型

- `before_model`: Model 调用前
- `after_model`: Model 调用后
- `before_tool_use`: 工具调用前
- `after_tool_use`: 工具调用后

## 使用

```ts
import { HookRegistry, executeHook } from "@vykor/hooks";

const registry = new HookRegistry();
registry.register({
  type: "before_model",
  name: "my-hook",
  handler: async (ctx) => { /* ... */ }
});
```

## 测试

```bash
pnpm --filter @vykor/hooks test
```