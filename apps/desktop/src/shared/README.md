# 桌面共享契约

主进程、preload 和 renderer 在这里共享请求/结果类型与不依赖 UI 的校验。

`ipc-channels.ts` 汇总调用通道；`desktop-api-contract.ts` 定义 `window.desktop`。业务种类分别在对应 `*-types.ts` 文件中维护。

`business-data-types.ts` 定义已知恢复键、记录版本和异步读写/刷新接口；`business-data-schema.ts` 复用 composer 草稿、待提交请求、笔记草稿和图片区域格式，主进程在读写前校验。这里不持有正文状态、不操作磁盘，也不导入 renderer store 或组件。

新增跨进程契约放对应业务的类型文件；纯校验可放同分类 schema 文件，测试放 `__test__/`。实际流程入口见主进程 `features` 各目录 README。

`maintenance-settings-types.ts` 的整根预检只返回路径、数量、冲突和影响；宿主 home/profile 不是 renderer 请求字段。business-data 的导出失败恢复通知只能从主进程发出，不提供 renderer 解锁接口。
