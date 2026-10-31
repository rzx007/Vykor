# 桌面设置服务

此目录负责桌面设置的读取、校验和保存，不持有智能体运行状态。`ipc.ts` 注册渲染页面的调用入口；`settings-service.ts` 将全局偏好交给应用客户端读写后台配置，将本机偏好交给 `desktop-preferences.ts` 保存，最后返回标准桌面快照。

回复风格通过 `updateReplyStyle` 校验后写入全局 `replyStyle`，使用原有设置更新接口。快照由 `src/shared/settings-types.ts` 组装，旧配置缺少回复风格或值无效时显示协作；写入未知值则直接报错，不修改配置。`workStyle` 继续单独控制进度通知。

其他设置服务分别处理权限、终端、Git、通知、配置迁移和数据维护。同类设置的输入校验与后台调用放在对应服务，纯桌面字段及调用类型放在 `src/shared`。新测试放在同级 `__test__`；回复风格测试覆盖默认值、保存后读取、错误值拒绝及保存失败。

`desktop-preferences-storage.ts` 同时保存最近的原生通知目标，供桌面重启后的通知激活查找原会话和待处理请求。只保留最近 1,000 条，读取时丢弃结构无效的目标；未确认的回复文字仅在本机保存，后台确认后清除。通知动作仍由 `../tray/notification-actions.ts` 处理，设置目录不执行授权。`__test__/notification-targets.test.ts` 使用实际文件验证无关设置保存不会丢失目标，成功后可清除回复文字。
