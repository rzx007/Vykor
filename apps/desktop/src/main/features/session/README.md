# 桌面会话入口

本目录承接桌面主进程的会话、项目和后台连接请求，将结果返回给 IPC（主进程与界面之间的消息通道）。

## 主要文件与调用流程

- `ipc.ts` 注册界面可调用的入口，沿用共享请求和返回类型。
- `session-service.ts` 的 `DesktopSessionService` 获取本次调用使用的 client（向后台发请求的连接对象），然后把它和输入交给具体操作。构造时可以传入连接依赖；不传时创建 `DaemonConnectionService`，连接后从主进程接上浏览器桥。
- `daemon-connection-service.ts` 用公开 SDK 查找或启动独立后台，校验协议与数据目录，保存当前会话连接。后台声明支持浏览器桥接时，桌面才与它建立桥接。主进程的管理操作按需使用同一地址和凭据创建 HTTP 请求连接，并由每个功能决定调用哪个接口。后台重启或切换数据目录后重新连接，连接失效时通知订阅方，连接失败后允许重试。
- `project-resource.ts` 从已认证连接读取和维护桌面的项目登记；`daemon-maintenance-resource.ts` 请求后台重启或切换会话数据库。项目记录和后台进程状态由后台管理。
- `session-operations.ts` 执行会话和项目操作。分支切换、创建分支与其他方法一样显式接收 client；Git 等待结束后仍用本次调用持有的 client 检查项目并返回详情，交错调用不会覆盖彼此的连接。
- `project-operations-support.ts` 执行 Git 命令、读取分支并补充项目目录是否可用。
- `session-subscription-service.ts` 保存窗口对应的会话订阅和推送状态。服务入口接到连接失效通知后清除订阅；活动订阅的连接替换由 `activitySubscriptions` 处理。
- `session-operation-input.ts` 校验操作输入；`runtime-selection.ts` 解析桌面默认模型选择。其余读取和转换辅助文件放在本目录对应功能旁。

`chooseProject` 通过系统弹窗选择目录，通过 `readLocalProjectDirectory` 读取本机 Git 分支。打开侧栏已登记的项目也使用本机分支读取入口。新目录在创建 Agent 会话前调用 `inspectProject`，用 daemon 返回的项目 ID 创建会话。

## 新增代码和测试

`read-tool-image-preview.ts` 仍只接受后台保存的成功 Read 图片结果；其 Native 历史路径先经 `resolveManagedHistoryPath` 解析并检查真实边界，再执行原图片格式、大小和解码限制。附件卡片使用 assetId，继续走已授权的附件下载流程；不会改写历史正文、工具参数原文或 Shell 命令。

新增会话或项目动作放在 `session-operations.ts` 或其对应职责的辅助文件，服务入口负责获取 client 和转交输入。连接缓存、重建与关闭逻辑保留在连接服务中，不在操作类保存临时 client。

新测试放在 `__test__/`；已有测试可就地补充。`__test__/session-branch-client.test.ts` 暂停 Git 步骤，验证交错的分支调用和迟到连接各自返回所属 client 的项目详情。现有 `session-operations-worktree.test.ts`、`session-service*.test.ts` 和 `daemon-connection-service.lifecycle.test.ts` 覆盖工作目录补偿、输入转交、切换失败恢复和安全关闭。

`session-service.ts` 的 `checkPromptAccepted` 只读取 daemon 的会话输入记录，返回指定输入 ID 是否已被接收；不打开订阅、不创建或重跑任务。renderer 在失败重试前调用对应 IPC，读取失败不能被解释为“未接收”。

会话订阅从公开 SDK 读取消息片段摘要，需要原文时按会话、消息和片段 ID 单独读取。用户引用的插件页面内容由主进程附在同一次输入提交中，由 daemon 校验应用租约和会话归属。

普通提交从桌面待发送记录取得交互界面开关的快照，发送重试复用该快照。编辑末条重发创建新输入，由桌面主进程在等待后台连接前读取当前开关。`session-operations.ts` 在开启时随输入提交 `replyPresentation`。已入队请求和重放沿用后台保存的原输入标记。插入当前运行的消息沿用该运行已有的说明。

`bootstrap()` 把进程已固定的用户根交给工作区文件访问列表；工作区服务没有显式 `allowedRoots` 时也使用同一个根，避免启动后的环境变量变化把受保护配置当成普通外部文件。`outside-project-workspace.ts` 直接接收 `workspacesDir`，以用户本地日期和独占 mkdir 分配 `workspaces/YYYY-MM-DD/xN`，失败只清理这次分配且仍为空的目录。bootstrap 返回同一个 workspaces 根，并隐藏规范 workspaces/channels、显式历史受管映射、已知渠道会话 cwd 和映射中的暂存/保留根。会话分类使用同一历史映射，不再永久识别 Documents/Vykor。

bootstrap 的项目列表也隐藏旧版在系统文档目录下分配的 `Vykor/YYYY-MM-DD/xN`。这条兼容规则只用于项目列表显示，历史目录即使没有迁移映射或关联会话也能识别。

`__test__/managed-data-root.test.ts` 在隔离用户根中贯通聊天、渠道 cwd、定时任务和真实 Git worktree 分配，检查五个目录都归属该根、真实外部项目 cwd 未改变、bootstrap 隐藏和文件允许根未扩大。
