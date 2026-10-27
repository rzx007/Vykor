# @vykor/hooks

执行模型调用、工具使用等运行事件上的钩子。钩子是事件发生时运行的命令、HTTP 请求或模型检查。

## 功能

- `HookExecutor` 按事件、启用状态和匹配条件挑选钩子，按优先级顺序执行。
- `HookLoader` 从配置或 `.hook.js`、`.hook.ts` 文件读取定义。
- 相同 ID 后注册的钩子覆盖已有定义。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/hooks` 导入 `HookExecutor`、`HookLoader` 和钩子类型。完整文件职责见 [src 源码说明](src/README.md)，测试在 [`src/__test__`](src/__test__)。

宿主加载定义后，在运行事件发生时调用 `execute(event, context)`。执行器筛选钩子并依次运行，返回是否阻止后续操作及原因。`command` 执行命令，`http` 读取服务响应，`prompt` 与 `agent` 使用宿主注入的模型客户端检查条件；没有模型客户端时跳过模型类检查。

注册定义和模型客户端由执行器实例保存在内存中，轮询计时器由加载器保存，配置文件由宿主管理。新增执行或加载逻辑放在 `src/`，测试放在同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/hooks test
```

两项 POSIX 命令参数与注入安全测试需要在 Linux 或 macOS 运行。严格沙箱不可用的测试显式指定隔离临时目录中不存在的运行器，不依赖开发机是否安装了 SRT；失败时阻止执行的原断言保持。
