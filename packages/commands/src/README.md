# 命令注册与执行

[`index.ts`](index.ts) 是 `@vykor/commands` 的公开入口，也是当前实现文件。它提供 `CommandRegistry`，以及 `CommandDefinition`、`CommandContext`、`CommandResult` 和参数说明类型。

调用方用 `register()` 注册命令和别名，`get()` 或 `list()` 查询，`execute(name, context)` 将上下文交给处理函数并返回结果。未知命令或处理函数抛错时，返回 `success: false` 与错误说明。参数类型只描述约定，本包不解析原始命令文本。

命令名、别名与定义保存在实例的内存表中，注册同名项会覆盖已有项。没有磁盘状态，输入解析和配置加载由调用方承担。

注册表相关逻辑继续放在本目录，保持小包结构紧凑。测试放在同层 [`__test__`](__test__)。返回[包说明](../README.md)。
