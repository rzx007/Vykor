# 桌面设置服务

此目录负责桌面设置的读取、校验和保存，不持有智能体运行状态。`ipc.ts` 注册渲染页面的调用入口；`settings-service.ts` 将全局偏好交给应用客户端读写后台配置，将本机偏好交给 `desktop-preferences.ts` 保存，最后返回标准桌面快照。


其他设置服务分别处理权限、终端、Git、通知、配置迁移和数据维护。同类设置的输入校验与后台调用放在对应服务，纯桌面字段及调用类型放在 `src/shared`。新测试放在同级 `__test__`。

消息链接打开方式通过 `getLinkOpeningMode`、`updateLinkOpeningMode` 直接读写本机 `desktop-preferences.json`，取值为询问、内置或系统浏览器；不访问 daemon，也不修改其配置。旧配置和无效值回退为询问，写入时拒绝未知值；其他偏好保存不会清除该选择。

`desktop-preferences-storage.ts` 同时保存最近的原生通知目标，供桌面重启后的通知激活查找原会话和待处理请求。只保留最近 1,000 条，读取时丢弃结构无效的目标；未确认的回复文字仅在本机保存，后台确认后清除。通知动作仍由 `../tray/notification-actions.ts` 处理，设置目录不执行授权。`__test__/notification-targets.test.ts` 使用实际文件验证无关设置保存不会丢失目标，成功后可清除回复文字。

`git-settings-service.ts` 的任务 worktree 默认传数据根给共同 manager；manager 自己追加 `worktrees/<仓库标识>`，登记中的 configDir 保留此含义。旧 worktreeRoot 为 null 或与当前数据根等价时允许新建，其他旧根给出具体迁移提示；已有登记仍按原路径保留和清理。Git 设置 JSON 的存放迁入由后续桌面业务存储任务处理，本层不改 Electron 外壳 userData。

`git-settings-storage.ts` 将 Git 偏好和 worktree 登记保存在数据根的 desktop 分类；只迁 JSON 记录，不更改实际 worktree 路径。旧 userData 文件经摘要核对后确认导入，默认保留。
