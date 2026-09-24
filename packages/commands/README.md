# @vykor/commands

斜杠命令注册表。

## 功能

- 命令注册和查找
- 参数解析

## 使用

```ts
import { CommandRegistry } from "@vykor/commands";

const registry = new CommandRegistry();
registry.register({ name: "test", handler: async (ctx) => {} });
```

## 测试

```bash
pnpm --filter @vykor/commands test
```