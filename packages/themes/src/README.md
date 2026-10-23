# 主题源码

[`index.ts`](index.ts) 是 `@vykor/themes` 的公开入口，定义 `ThemeColors`、`ThemeDefinition`，实现 `ThemeManager` 并导出内置主题。

| 目录 | 用途 |
| --- | --- |
| [builtin](builtin/README.md) | 内置主题定义与 `builtinThemes` 列表 |
| [__test__](__test__) | 包公开入口和主题管理行为测试 |

创建管理器时把内置列表放入主题表并选择 `default`。`register()` 按名称加入或覆盖定义，`setActive()` 检查名称后切换，`getActive()` 返回当前定义，具体颜色如何渲染由调用方决定。

主题表和活动名称属于每个 `ThemeManager` 实例，模块不读写配置文件。新增管理逻辑放本目录，内置主题放 `builtin/`；管理器与包入口测试放本层 `__test__/`，独立内置主题测试可放 `builtin/__test__/`。返回[包说明](../README.md)。
