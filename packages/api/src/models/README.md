# 模型目录

加载模型名称、能力和计费元数据，筛选可以直接使用 API Key 的服务商。

## 主要文件

- [catalog.ts](catalog.ts)：模型目录服务、加载优先级和本地缓存。
- [api.json](api.json)：随包提供的目录兜底数据。
- [special-provider-catalog.ts](special-provider-catalog.ts)：补充 Codex 等特殊服务商和默认模型。
- [direct-api-key-providers.ts](direct-api-key-providers.ts)：整理可使用独立 API Key 的服务商。

## 调用与状态

从包根使用 `createModelCatalogService().load()` 或 `ModelCatalogService`，用 `listDirectApiKeyCatalogProviders` / `toDirectApiKeyProvider` 筛选目录。

优先读取 `VYKOR_MODELS_PATH` 指定的有效目录；否则尝试联网获取，并在失败时使用内存、本地缓存或随包数据。设置 `VYKOR_DISABLE_MODELS_FETCH` 时直接使用随包数据。每种来源最后都会合并特殊服务商定义。

服务实例保存已加载目录与进行中的加载 Promise；工厂按配置目录和相关环境变量复用实例。磁盘缓存位于配置目录的 `cache/models-dev.json`，目录路径由 `@vykor/host-config` 解析。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
