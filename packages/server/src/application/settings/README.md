# 配置导入与导出

提供可迁移配置的解析、导入和导出。

## 入口与流程

`exportPortableSettings()` 按配置分组生成可移植内容；`parsePortableSettings()` 验证格式；`importPortableSettings()` 应用通过校验的修改并返回结果。

回复风格 `replyStyle` 归入 `general` 分类，导出持久配置中的三档值，导入时拒绝会话专用的 `inherit`。文件省略该字段时保留原偏好，旧版文件仍可导入。

## 状态归属

实际配置由 host-config 读取和保存；本目录处理传输内容，不保存额外配置副本。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [settings-transfer.ts](./settings-transfer.ts) | `SETTINGS_TRANSFER_GROUPS`、`PortableSettings`、`parsePortableSettings`、`exportPortableSettings` 等 |

## 测试与维护

配置传输格式、分组和导入规则放在这里，日常配置接口适配放在 default-services/configuration。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
