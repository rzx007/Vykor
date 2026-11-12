# 桌面业务恢复数据

`ipc.ts` 注册 `window.desktop.businessData` 的已知种类入口，只接受 composer、notes、quick-notes 和 SHA-256 图片摘要键，不接受磁盘路径。主进程通过 `business-data-schema.ts` 校验正文。

`business-data-service.ts` 将记录保存在 `dataRoot/data/desktop/`。每次写入携带读取时的 revision（版本号）；单一队列先比对版本，再写临时文件并替换目标。旧版本或写盘失败会拒绝请求，`flush()` 等待队列并报告未解决的写入失败。

`legacy-composer.ts` 通过既有 session get 入口仅判定会话是否持久、临时或不存在。renderer 在导出前过滤临时和 linked-chat 正文；不存在的会话仅留下 ID，原旧键保留。

`legacy-import.ts` 管理 `legacy-import.json`：来源原文 SHA-256、目标规范值摘要、revision 和确认状态。目标写入后重新读取并核对摘要才写确认。来源相同的旧副本不会覆盖后来更新的目标；来源改变会失败。Git JSON 同用这个同步原子确认入口，保留原 worktree 路径。

composer 的 `partial` 记录含 `unresolvedSessionIds` 和 `reason: session-not-found`。迁移预检应将未确认 partial 列为 `needs_desktop_export`。`acknowledgeUnresolvedComposer(sourceDigest)` 只对匹配摘要的现有 partial 标记 `retainedSourceAcknowledged: true`；不改正文、不删除旧副本。迁移界面需让用户明确选择保留旧副本后调用。

`window-flush.ts` 只跟踪主业务窗口，且以 renderer 注册 flush listener 的 consumer-ready 通知作为参与起点；尚未加载、没有消费者的窗口直接完成。发送随机请求 ID 并核对 renderer 回执及 sender。`flushDesktopBusinessData()` 是关闭和未来根迁移的等待入口，必须在 IPC/renderer 被销毁前调用；失败不允许继续。它等待已有工作，不替代迁移协调者的停写锁。宠物和插件窗口不参与。

同职责的新校验和导入逻辑放本目录；跨进程类型和纯 schema 放 `src/shared`。测试放 `__test__/`，仅使用临时目录。
