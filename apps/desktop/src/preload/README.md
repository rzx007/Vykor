# 桌面 preload

index.ts 在主 frame 暴露经过类型约束的调用；desktop-api.ts 将业务方法送到固定 IPC 通道，结果沿同一 Promise 返回。共享类型放在 ../shared，本层不持有业务数据。

带宿主设置的 --data-root-maintenance 的旧布局维护窗口仅暴露业务导出、未归属摘要确认、整根预检/迁移/记录恢复和选目录，不暴露通用 Electron、会话、预算、自启或任意 IPC。正常窗口沿用完整 API。最终业务 flush 支持冻结；只有主进程确认未封门导出失败且原根恢复后，才通知恢复交互。

新增桥接及测试放在本分类与 __test__/，不要把 home、profile 或任意路径能力变成 renderer 参数。
