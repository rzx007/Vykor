# Markdown 笔记

保存笔记索引，并协调 Markdown 文件与记录修订。

## 入口与流程

NoteRepository 查询、创建、修改和删除笔记；文件辅助函数检查路径与内容，并以替换文件的方式写入；修订冲突通过明确错误返回。

## 状态归属

正文保存在笔记目录的 Markdown 文件，数据库保存索引和相关元数据；修改通过共享事务接口协调。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreateNoteInput`、`UpdateNoteInput` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [markdown-note-files.ts](./markdown-note-files.ts) | `ensureNoteDirectory`、`noteFilePath`、`readNoteFile` 等 |
| [note-repository.ts](./note-repository.ts) | `NoteRevisionConflictError`、`NoteRepository` |

## 测试与维护

笔记的命令、索引与文件处理一起维护，HTTP 校验和界面操作放在应用层。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
