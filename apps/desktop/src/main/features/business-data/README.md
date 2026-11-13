# 桌面业务恢复数据

`ipc.ts` 注册 `window.desktop.businessData` 的已知种类入口，只接受 composer、notes、quick-notes 和 SHA-256 图片摘要键，不接受磁盘路径。主进程通过 `business-data-schema.ts` 校验正文。

`business-data-service.ts` 将记录保存在 `dataRoot/data/desktop/`。每次写入携带读取时的 revision（版本号）；单一队列先比对版本，再写临时文件并替换目标。旧版本或写盘失败会拒绝请求，`flush()` 等待队列并报告未解决的写入失败。

`legacy-composer.ts` 通过既有 session get 入口仅判定会话是否持久、临时或不存在。renderer 在导出前过滤临时和 linked-chat 正文；不存在的会话仅留下 ID，原旧键保留。

`legacy-import.ts` 管理 `legacy-import.json`：来源原文 SHA-256、目标规范值摘要、revision 和确认状态。目标写入后重新读取并核对摘要才写确认。来源相同的旧副本不会覆盖后来更新的目标；来源改变会失败。Git JSON 同用这个同步原子确认入口，保留原 worktree 路径。

composer 的 `partial` 记录含 `unresolvedSessionIds` 和 `reason: session-not-found`。迁移预检应将未确认 partial 列为 `needs_desktop_export`。`acknowledgeUnresolvedComposer(sourceDigest)` 只对匹配摘要的现有 partial 标记 `retainedSourceAcknowledged: true`；不改正文、不删除旧副本。迁移界面需让用户明确选择保留旧副本后调用。

`window-flush.ts` 只跟踪主业务窗口，且以 renderer 注册 flush listener 的 consumer-ready 通知作为参与起点；尚未加载、没有消费者的窗口直接完成。发送随机请求 ID 并核对 renderer 回执及 sender。`flushDesktopBusinessData()` 是关闭和未来根迁移的等待入口，必须在 IPC/renderer 被销毁前调用；失败不允许继续。它等待已有工作，不替代迁移协调者的停写锁。宠物和插件窗口不参与。

同职责的新校验和导入逻辑放本目录；跨进程类型和纯 schema 放 `src/shared`。测试放 `__test__/`，仅使用临时目录。

`legacy-import.json` 可包含 `desktopScan:{version:1,id,userDataDir,documentsDir,sources}`。sources 是所有当前支持 localStorage 键的 sourceId→原字符串 SHA-256，可为空；renderer 只提交摘要，两个系统路径由 main 的 `app.getPath` 绑定。启动恢复完成后和每次 renderer flush 末尾都重新扫描。主进程沿既有业务队列核对来源确认和目标记录，保存收据；未知来源、摘要改变或缺失目标使旧收据失效。partial 可留下未就绪收据供普通启动继续，迁移仍需匹配摘要的明确 ACK。

T10/T11 可在取得迁移互斥并冻结编辑之后调用 `prepareDesktopBusinessDataExport()`。该函数等待既有 flush，并要求产生不同于调用前的扫描 ID，且所有当前支持来源 confirmed 或已有 partial ACK，返回 `{desktopExportPath,scanId,userDataDir,documentsDir}`；没有就绪 renderer、只存在旧收据或有未处理 partial 时失败为 `needs_desktop_export`。调用方保持冻结直到迁移结束/取消，不能在读取收据后提前销毁 IPC。主进程不解析 LevelDB，旧键和桌面偏好继续保留；历史 targetDigest 不约束用户后来正常编辑的目标。

根迁移使用 `prepareDesktopRootMigration(pauseConnections)`：先拒绝新增普通 IPC 并等完整异步调用（含 Git 子进程）结束；要求所有主业务 renderer 冻结编辑、完成业务写队列及新扫描；随后封住业务 IPC、暂停连接重试，最后释放 Desktop 的根写资格。未知/未就绪窗口不能充当完成证明。freeze 失败后仍保持冻结，调用方应关闭并重新启动 Desktop，不能把持旧路径的对象原地转到新根。

本机旧布局维护使用 createBusinessDataIpcContribution(lookup)，分类函数来自已核对的真实旧数据集；默认窗口继续通过已有 daemon 分类。最终 flush 失败且尚未 seal 时，只有设置宿主确认原根恢复和无 pending 后才能通知 renderer 恢复交互；已 seal 窗口退出时不再二次 flush。

legacy-import.json 的顶层 legacySources 只由本机维护宿主提供已核实路径和身份，renderer 只能提交支持键摘要。普通 scan 失效不会删除这份来源证据；目标迁移副本置 consumed 后继续保留审计，不作为下次迁移输入。
