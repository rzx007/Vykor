# 桌面主进程调用

`registry.ts` 注册 renderer 到 main 的调用，`wrap-handler.ts` 统一转换错误并用 `operation-gate.ts` 跟踪完整调用生命周期。结果沿原 IPC 返回 renderer。

根迁移先进入 draining：拒绝新增普通调用、等待已有异步操作及 Git 子进程，只允许最终业务 flush；封闭为 sealed 后等待所有业务调用结束。触发迁移的当前调用用 AsyncLocalStorage 标记，避免等待自身。状态属于本 Desktop 进程，释放根资格后通过进程重启恢复正常服务。

同类 IPC 包装放这里；业务处理放 features 对应目录。测试在 `__test__/`，包括真实临时 Git index 操作的排空。

唯一恢复交互例外是业务导出未完成且尚未 sealed 的准备失败。设置宿主先确认协调器已恢复原根、原目录身份相同且没有 pending，才调用受限 resumeAfterFailedExport；renderer 没有该方法的调用入口。sealed 对象仍必须退出并重建。
