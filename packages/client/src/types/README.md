# 客户端接口类型

集中定义附件、扩展能力和状态同步使用的客户端类型。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [attachment-types.ts](./attachment-types.ts) | `UploadAttachmentInput`、`DownloadAttachmentOptions`、`AttachmentStorageIssue` |
| [extension-types.ts](./extension-types.ts) | `PluginRuntimeStatus`、`PluginInfo`、`PluginArchivePreview` |
| [index.ts](./index.ts) | `ScheduledTaskStatusSummary`、`VykorClientOptions`、`VykorServerHealth` |
| [sync-types.ts](./sync-types.ts) | `SessionBucket`、`VykorClientState`、`EventSyncOptions` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

命令、资源接口和状态模块引用这些定义，调用方依照相同字段创建输入并接收结果。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
