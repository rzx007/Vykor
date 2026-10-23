# 输出样式加载

[`index.ts`](index.ts) 是 `@vykor/output-styles` 的公开入口和实现文件，定义 `OutputStyleDefinition`，并提供加载目录、读取样式和名称校验函数。

`getOutputStylesDir()` 尝试创建 `~/.vykor/output_styles`。`loadOutputStyles()` 复制内置列表，再读取该目录的 `.md` 文件并按文件名追加用户样式；无法读取的文件会跳过。`isKnownOutputStyle()` 检查返回列表中是否存在指定名称。

磁盘文件属于用户配置，返回的样式列表属于调用方。本包没有活动样式状态，也不负责终端渲染；`content` 是说明文字，渲染器依据 `name` 选择行为。

保持单层实现，新增加载与校验逻辑放在本目录，测试放同层 [`__test__`](__test__)。返回[包说明](../README.md)。
