# API 源码

[index.ts](index.ts) 是 `@vykor/api` 的公开入口，集中导出流式客户端、服务商识别、模型目录、统一错误和请求头模板；内部辅助函数按分类维护，不因文件内 `export` 就自动成为包 API。

## 目录导航

- [providers/](providers/README.md)：注册表、客户端和工具、媒体、请求、流处理。
- [models/](models/README.md)：模型目录加载、缓存和服务商筛选。
- [errors/](errors/README.md)：请求失败分类与错误信息整理。

调用方先识别服务商、提供凭据和模型，再准备用户内容并调用客户端的 `streamMessage`。客户端把请求交给 SDK 或 HTTP 接口，把响应转换成 `@vykor/agent-contracts` 定义的事件；上层消费这些事件。

请求状态保留在单次调用中；目录与图片缓存分别归 models 和 providers/media。新增逻辑先进入对应分类，只有对外能力才补本层导出。单模块测试放所属分类的 `__test__/`；未来真正跨分类的包级测试放本层 `__test__/`，目前本层没有该目录。
