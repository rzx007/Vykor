# @vykor/commands

斜杠命令注册表，按命令名或别名查找处理函数并返回执行结果。

## 功能

- 命令注册和查找
- 按名执行处理函数，并把异常转成错误结果

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/commands` 导入 `CommandRegistry` 和命令类型。实现与扩展位置见 [src 源码说明](src/README.md)，现有测试在 [`src/__test__`](src/__test__)。

调用方先注册命令，再把已经整理好的 `CommandContext` 交给 `execute()`，结果由处理函数返回。命令与别名保存在注册表实例内存中，原始输入解析和长期配置由调用方负责。

## 使用

```ts
import { CommandRegistry } from "@vykor/commands";

const registry = new CommandRegistry();
registry.register({
  name: "test",
  description: "执行示例命令",
  handler: async () => ({ success: true, output: "ok" }),
});
```

## 测试

```bash
pnpm --filter @vykor/commands test
```
