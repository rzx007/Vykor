# 会话记录通用操作

提供会话文本筛选、导出和记录回退的通用函数。

## 入口与流程

导出函数把消息与部件生成指定格式并写出文件；回退函数计算保留范围；文本辅助函数判断可公开的已提交文本。

## 状态归属

原始会话记录由调用方传入，导出内容写入目标文件，回退结果交由应用层保存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [export-session.ts](./export-session.ts) | `SessionExportFormat`、`BuildSessionExportInput`、`SessionExportResult`、`writeSessionExport` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [rewind.ts](./rewind.ts) | `RewindTranscriptResult`、`rewindTranscript` |
| [transcript-text.ts](./transcript-text.ts) | `isPublicTextPart`、`isCommittedPublicTextPart`、`publicTextFromParts` |

## 测试与维护

与服务实例无关的记录算法放在这里；操作许可与会话变更协调放在 application/session/maintenance。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
