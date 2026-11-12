# Renderer 公用辅助逻辑

这里存放页面共用的纯转换、浏览器交互和小型状态辅助代码；具体业务 UI 留在对应 `components` 分类。

`business-data.ts` 为四类桌面恢复记录维护每个 API 实例的已读版本和写入队列。先等待读取，再按旧版本提交；初始化期间不提交空值。`registerBusinessDataFlusher` 收集消费者尚未提交的编辑，`flushRendererBusinessData` 等待所有消费者和主进程文件队列。主 renderer 入口在收到关闭请求后 await 它并回执。

`importOtherLegacyBusinessData` 只扫描已知笔记键和 SHA-256 图片批注键；composer 需要会话分类，由 `stores/desktop-session/composer-recovery.ts` 单独导入。原旧键不删除。状态只留在当前 renderer 内存，正式正文保存在主进程所选数据根。

`toast.ts` 负责现有错误提示，`notification-sound.ts` 播放通知音；其他文件按名称对应具体浏览器辅助能力。新增跨页面逻辑放这里，测试放 `__test__/`。
