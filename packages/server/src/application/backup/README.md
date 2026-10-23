# 应用备份与恢复

备份数据库及相关目录，校验清单并恢复应用数据。

## 入口与流程

`createApplicationBackup()` 收集数据库和附件等目录，生成带校验信息的清单；`restoreApplicationBackup()` 检查内容后恢复目标数据。

## 状态归属

备份清单与文件保存在备份目录，运行数据仍由数据库与对应内容目录持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-backup.ts](./application-backup.ts) | `BackupSourceDirectories`、`ApplicationBackupManifest`、`createApplicationBackup`、`restoreApplicationBackup` 等 |

## 测试与维护

备份格式、校验和恢复步骤放在这里；执行前的停机与互斥由上层维护服务协调。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
