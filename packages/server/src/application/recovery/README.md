# 启动恢复

在应用启动时修复未完成的执行状态并处理历史记录遗留操作。

## 入口与流程

`StartupRecoveryService` 遍历需要恢复的会话和运行，调用存储与恢复能力完成状态修正，再允许正常业务继续。

## 状态归属

恢复事实写回既有存储；本目录保存恢复期间的协调状态，不新建另一套运行记录。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [startup-recovery-service.ts](./startup-recovery-service.ts) | `StartupRecoveryServiceOptions`、`StartupRecoveryService` |

历史操作收尾模块仅处理旧记录中未完成的操作，与启动恢复服务一起维护。

## 测试与维护

启动时恢复和历史数据收尾放在这里；活跃执行事件的补写放在 agent。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
