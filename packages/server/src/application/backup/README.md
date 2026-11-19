# 应用备份与恢复

备份数据库及相关目录，校验清单并恢复应用数据。

## 入口与流程

`createApplicationBackup()` 收集数据库和附件等目录，生成标记为 `daemon-only` 的第 4 版清单。它从数据库副本移除旧便签正文、索引和附件行，当前数据库和旧便签文件保持原样。

`verifyApplicationBackup()` 校验清单和文件。第 3 版的便签会在临时副本上核对 Markdown 正文、索引和组织文件。`restoreApplicationBackup()` 验证后发布恢复目标。恢复第 1、2 版时从旧 SQLite 重建 Markdown。第 3 版保留已验证的 Markdown 和组织文件，桌面导入可读取恢复目录中的旧便签。

## 状态归属

备份清单与文件保存在备份目录，运行数据仍由数据库与对应内容目录持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-backup.ts](./application-backup.ts) | `BackupSourceDirectories`、`ApplicationBackupManifest`、`createApplicationBackup`、`restoreApplicationBackup` 等 |

## 测试与维护

备份格式、校验和恢复步骤放在这里；执行前的停机与互斥由上层维护服务协调。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
