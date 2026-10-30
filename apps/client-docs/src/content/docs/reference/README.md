# API 参考维护

[overview.md](./overview.md) 是手写 API 入口说明，介绍根入口与 Node 服务入口、资源分工及生成方式。入口来自首页和各操作指南。

完整 API 页面由 TypeDoc 与 Starlight 插件从发布声明生成，签名和类型的事实源是 `packages/client/dist/index.d.ts` 与 `packages/client/dist/service.d.ts`。生成文件不在这里手工维护；公开 API 变动先更新源码、导出和契约，再重新构建 SDK 与站点。

此目录只保存解释性内容和公开参考导航，不保存运行状态。新增调用流程放 `guides/`，不要把全部服务端 API 或私有应用资源混入参考生成范围。
