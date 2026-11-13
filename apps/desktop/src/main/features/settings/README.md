# 桌面设置服务

此目录负责桌面设置的读取、校验和保存，不持有智能体运行状态。`ipc.ts` 注册渲染页面的调用入口；`settings-service.ts` 将全局偏好交给应用客户端读写后台配置，将本机偏好交给 `desktop-preferences.ts` 保存，最后返回标准桌面快照。


其他设置服务分别处理权限、终端、Git、通知、配置迁移和数据维护。同类设置的输入校验与后台调用放在对应服务，纯桌面字段及调用类型放在 `src/shared`。新测试放在同级 `__test__`。

消息链接打开方式通过 `getLinkOpeningMode`、`updateLinkOpeningMode` 直接读写本机 `desktop-preferences.json`，取值为询问、内置或系统浏览器；不访问 daemon，也不修改其配置。旧配置和无效值回退为询问，写入时拒绝未知值；其他偏好保存不会清除该选择。

`desktop-preferences-storage.ts` 同时保存最近的原生通知目标，供桌面重启后的通知激活查找原会话和待处理请求。只保留最近 1,000 条，读取时丢弃结构无效的目标；未确认的回复文字仅在本机保存，后台确认后清除。通知动作仍由 `../tray/notification-actions.ts` 处理，设置目录不执行授权。`__test__/notification-targets.test.ts` 使用实际文件验证无关设置保存不会丢失目标，成功后可清除回复文字。

`git-settings-service.ts` 的任务 worktree 默认传数据根给共同 manager；manager 自己追加 `worktrees/<仓库标识>`，登记中的 configDir 保留此含义。旧 worktreeRoot 为 null 或与当前数据根等价时允许新建，其他旧根给出具体迁移提示；已有登记仍按原路径保留和清理。Git 设置 JSON 的存放迁入由后续桌面业务存储任务处理，本层不改 Electron 外壳 userData。

`git-settings-storage.ts` 将 Git 偏好和 worktree 登记保存在数据根的 desktop 分类；只迁 JSON 记录，不更改实际 worktree 路径。旧 userData 文件经摘要核对后确认导入，默认保留。

启用自动清理时，保存 Git 偏好的 IPC 会等待本次 worktree 清理和登记更新结束才返回；迁移冻结因此能排空已取得 daemon client 的异步 Git 操作，再 flush 和释放 Desktop 写资格。`__test__/git-cleanup-drain.test.ts` 覆盖这条实际调用链。

`data-root-settings-service.ts` / `data-root-settings-ipc.ts` 提供整根维护，home、Documents、userData 均由宿主确定，renderer 只选择完整目标或迁移记录。迁移复用服务器协调器及最终业务 flush、新扫描和封门。封门后成功和回退都恢复原始外部环境来源、以首位目标参数重启 Desktop，不复用旧客户端、不再次 flush sealed renderer。未完成导出的失败仅在协调器确认原 source 身份、无 pending 且未封门时恢复交互，保留内存草稿允许重试；恢复失败保持冻结并提供本记录恢复重试。旧 switchData 与 session 只切库接口明确返回整根迁移提示，不再追加 sessions.db，备份页也不再提供旧切库按钮。

“关闭窗口并恢复”在最后业务保存失败时，同样核对原目录身份与根选择记录；尚未封门、没有待恢复迁移且原根未变，才解除操作暂停并把保存失败返回页面，用户可继续编辑和重试。有效根按进程初始化时的显式参数、原始环境、保存记录优先级重新计算，合法覆盖其他保存根不影响重试；记录不可读、待恢复迁移、移动标记、有效选中根改变或原目录被替换都不放行。无法确认时，主进程持续保留原生恢复对话框，提供按当前 pending 记录恢复和重新检查原根的入口，不依赖已经冻结的页面。只有重新确认原根安全后才恢复页面，内存草稿始终保留。`__test__/data-root-recovery-export.test.ts` 从设置 IPC 经过实际操作门和窗口保存回执覆盖这些分支。
