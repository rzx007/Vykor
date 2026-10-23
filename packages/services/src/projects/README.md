# 项目记录

保存项目路径、名称、固定状态、默认 Shell 和位置历史。

## 入口与流程

ProjectRepository 处理查询、检查与更新；记录辅助函数规范路径并转换数据库行，供应用层完成项目范围的操作。

## 状态归属

项目及位置事实保存在 SQLite，工作目录、终端和活跃会话由调用方管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [project-records.ts](./project-records.ts) | `projectFromRow`、`normalizeProjectPath`、`defaultProjectName` |
| [project-repository.ts](./project-repository.ts) | `ProjectRepository` |

## 测试与维护

项目记录与路径规范放在这里，Git 操作和活跃工作检查由应用层负责。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
