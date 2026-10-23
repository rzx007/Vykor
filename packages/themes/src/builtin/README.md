# 内置主题

[`index.ts`](index.ts) 保存 `defaultTheme`、`darkTheme`、`minimalTheme`、`cyberpunkTheme`、`solarizedTheme`，并按默认注册顺序汇总为 `builtinThemes`。这些定义通过 `@vykor/themes` 的 [`../index.ts`](../index.ts) 公开导出。

每个主题提供名称、展示名和统一颜色字段。`ThemeManager` 构造时遍历 `builtinThemes` 注册定义，界面从管理器取得所选主题后应用颜色。

本目录只有静态定义，不保存当前主题或用户选择；运行中的主题表与活动名称由 `ThemeManager` 实例保存。新增内置配色放在本目录并加入列表，独立测试放同层 `__test__/`；现有管理器及入口测试在 [`../__test__`](../__test__)。返回[源码导航](../README.md)。
