# Markdown 笔记

保存笔记索引，并协调 Markdown 文件与记录修订。

## 入口与流程

NoteRepository 查询、创建、修改和删除笔记；文件辅助函数检查路径与内容，并以替换文件的方式写入；修订冲突通过明确错误返回。

## 状态归属

正文保存在笔记目录的 Markdown 文件，数据库保存索引和相关元数据；修改通过共享事务接口协调。

## 主要文件

| 文件                                                                 | 主要接口或用途                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [commands.ts](./commands.ts)                                         | `CreateNoteInput`、`UpdateNoteInput`                                        |
| [index.ts](./index.ts)                                               | 汇总本分类的接口                                                            |
| [markdown-note-files.ts](./markdown-note-files.ts)                   | `ensureNoteDirectory`、`noteFilePath`、`readNoteFile` 等                    |
| [note-repository.ts](./note-repository.ts)                           | `NoteRevisionConflictError`、`NoteRepository`                               |
| [note-organization.ts](./note-organization.ts)                       | 复用浏览器安全的组织类型与纯函数，模型定义在 domain-contracts 的 notes 分类 |
| [note-organization-repository.ts](./note-organization-repository.ts) | 组织读取、对账、条件保存、损坏保护和恢复校验                                |

`organization()` 只扫描 Markdown 文件名和普通文件状态后读取 `organization.json`，清除失效或重复归属、解散不足两张的文件夹，并将新正文追加到桌面。组织读写仍检查存储是否可写、目录是否安全，并保留首次旧数据库正文迁移；常规整理不读取正文、不计算正文哈希、不更新正文索引或修订号。`saveOrganization(organization, expectedEtag)` 在保存队列实际执行时重新扫描现有便签 ID，再检查完整归属和文件保存基线，冲突时拒绝写入。队列以 UTF-8 临时文件、fsync 和同目录重命名替换，并将校验时版本保存在 `organization.previous.json`。这不能保护其他程序在校验与替换之间的极短时间内写入的新版本。

损坏数据先保存为唯一的 `organization.corrupt-时间戳-随机值.json`，再重建桌面并返回警告；未来版本保留原文并只读。写入后再次读取，若内容或文件身份与本次写入不符，则暂停该仓库实例的后续写入并返回只读警告，用户检查当前文件与 previous 后重启应用。删除正文后整理失败不撤销正文删除，下次读取继续对账并返回警告；外层事务回滚时不改归属。备份携带组织文件及存在的 previous；恢复不修改备份原文，旧备份没有组织文件时由首次读取生成。previous 是历史恢复副本，允许引用此后删除的正文；当前文件必须完整引用备份中的正文。恢复入口为桌面的“打开便签文件夹”，可在目录中查看当前文件与 previous。

## 测试与维护

笔记的命令、索引与文件处理一起维护，HTTP 校验和界面操作放在应用层。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
