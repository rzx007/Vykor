# 会话命令目录

定义内置斜杠命令，并与插件及技能提供的命令合并。

## 入口与流程

默认目录读取可用命令，`parseSlashLine()` 解析输入，`mergeCommandCatalog()` 合并来源并返回统一目录供应用和界面使用。

## 状态归属

命令目录根据当前配置与扩展生成，不在本目录持久化。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CommandKind`、`CommandSelection`、`CommandSource`、`SessionCommandCatalogEntry` 等 |
| [default-command-catalog.ts](./default-command-catalog.ts) | `createDefaultCommandCatalog` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

命令定义、名称规范和目录合并放在这里，具体命令执行仍由对应应用服务处理。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
