# 笔记应用服务

提供笔记查询、保存和删除的应用入口。

## 入口与流程

`createNoteApplicationService()` 接收笔记操作，验证范围后调用笔记存储，向上层返回记录或操作结果。

## 状态归属

笔记内容由传入的存储能力保存，本目录不维护第二份笔记数据。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [note-application-service.ts](./note-application-service.ts) | `NoteApplicationContext`、`createNoteApplicationService`、`NoteApplicationService` |

## 测试与维护

笔记业务规则与应用接口放在这里，HTTP 参数转换放在 http/routes。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
