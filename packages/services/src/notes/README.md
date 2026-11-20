# Markdown 笔记

保存 Desktop 便签正文、组织和索引，保留旧会话库的读取兼容。

## 入口与流程

Desktop 主进程从 `@vykor/services/notes` 调用 `openDesktopNoteRepository(directory)`，用返回的 `repository` 查询、创建、更新和删除便签。每次正文读写先取得 SQLite 写锁，再核对 Markdown 与索引。发现外部编辑时，先登记新修订，再判断调用方传来的版本是否仍可写。关闭前由调用方排空写入并调用 `close()`。

`importLegacyNotes()` 接受停写的旧库和便签目录。它将旧 SQLite 与 WAL（保存已提交、尚未合入主库的记录）复制到临时工作区，只打开副本，读取旧索引、旧内嵌正文和删除记录。新 Markdown、索引、组织与导入收据在目标同一磁盘上暂存。校验成功后一次重命名发布；同一来源重试会保留已发布目录里的编辑和删除，不同的旧来源碰到独立目标会报告冲突。

`backupTo()` 将一致的索引和 Markdown 写入调用方提供的空暂存目录。`validateDesktopNotes()` 只读检查 SQLite、正文哈希、组织和收据，不生成新目录。整根迁移在后台停写后检查完成的副本。旧备份和首次升级仍可读取历史 `note` 和 `note_file_index`，旧 `note_attachment` 随原库保留。

## 状态归属

当前正文保存在 `data/desktop/notes/` 的 Markdown 文件，`notes.sqlite` 记录修订、时间、正文摘要和删除标记，`organization.json` 和 `organization.previous.json` 保存整理与上一次版本。`import-receipt.json` 标明导入版本和旧来源的内容摘要。旧记录的读取使用单独的兼容入口。

## 主要文件

| 文件                                                                 | 主要接口或用途                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [commands.ts](./commands.ts)                                         | `CreateNoteInput`、`UpdateNoteInput`                                        |
| [index.ts](./index.ts)                                               | 汇总本分类的接口                                                            |
| [desktop-note-index.ts](./desktop-note-index.ts)                       | 打开独立 SQLite，负责事务、索引和备份副本                                 |
| [desktop-note-repository.ts](./desktop-note-repository.ts)             | Desktop 打开、关闭和备份校验入口                                           |
| [legacy-note-import.ts](./legacy-note-import.ts)                       | 旧便签一次性导入、暂存校验和发布                                           |
| [legacy-note-repository.ts](./legacy-note-repository.ts)               | 旧会话库的兼容适配                                                         |
| [note-index.ts](./note-index.ts)                                      | 正文仓库需要的索引操作和事务回调                                           |
| [markdown-note-files.ts](./markdown-note-files.ts)                   | `ensureNoteDirectory`、`noteFilePath`、`readNoteFile` 等                    |
| [note-repository.ts](./note-repository.ts)                           | `NoteRevisionConflictError`、`NoteRepository`                               |
| [note-organization.ts](./note-organization.ts)                       | 复用浏览器安全的组织类型与纯函数，模型定义在 domain-contracts 的 notes 分类 |
| [note-organization-repository.ts](./note-organization-repository.ts) | 组织读取、对账、条件保存、损坏保护和恢复校验                                |

`organization()` 只扫描 Markdown 文件名和普通文件状态后读取 `organization.json`，清除失效或重复归属、解散不足两张的文件夹，并将新正文追加到桌面。组织读写仍检查存储是否可写、目录是否安全，并保留首次旧数据库正文迁移；常规整理不读取正文、不计算正文哈希、不更新正文索引或修订号。`saveOrganization(organization, expectedEtag)` 在保存队列实际执行时重新扫描现有便签 ID，再检查完整归属和文件保存基线，冲突时拒绝写入。队列以 UTF-8 临时文件、fsync 和同目录重命名替换，并将校验时版本保存在 `organization.previous.json`。这不能保护其他程序在校验与替换之间的极短时间内写入的新版本。

损坏数据先保存为唯一的 `organization.corrupt-时间戳-随机值.json`，再重建桌面并返回警告；未来版本保留原文并只读。写入后再次读取，若内容或文件身份与本次写入不符，则暂停该仓库实例的后续写入并返回只读警告，用户检查当前文件与 previous 后重启应用。删除正文后整理失败不撤销正文删除，下次读取继续对账并返回警告；外层事务回滚时不改归属。备份携带组织文件及存在的 previous；恢复不修改备份原文，旧备份没有组织文件时由首次读取生成。previous 是历史恢复副本，允许引用此后删除的正文；当前文件必须完整引用备份中的正文。恢复入口为桌面的“打开便签文件夹”，可在目录中查看当前文件与 previous。

## 测试与维护

笔记的命令、索引与文件处理一起维护，HTTP 校验和界面操作放在应用层。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
