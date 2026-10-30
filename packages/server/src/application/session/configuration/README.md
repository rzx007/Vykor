# 会话运行配置

组合会话运行配置，并发现当前目录可用的技能、插件和模型限制。

## 入口与流程

配置函数读取、更新运行元数据并判断变化；发现工厂按工作目录解析配置与扩展，向会话组装提供回调。

会话 `replyStyle` 的具体值优先于传入默认值；缺少字段或设为 `inherit` 时使用调用方当前提供的默认值。没有默认值的读取保留 `inherit`，供命令服务识别恢复继承这一变化；持久元数据一直保存该标记，不把它替换成某次读取的全局值。

## 状态归属

运行配置保存在会话元数据中，发现结果来自当前配置和扩展服务。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [runtime-configuration.ts](./runtime-configuration.ts) | `readSessionRuntimeConfig`、`patchSessionRuntimeMetadata`、`runtimeMetadataChanged`、`changedSessionRuntimeKeys` |
| [session-runtime-discovery.ts](./session-runtime-discovery.ts) | `SessionRuntimeDiscoveryOptions`、`createSessionRuntimeDiscovery` |

## 测试与维护

会话级配置合并、修订与发现放在这里；全局配置读写由默认配置服务负责。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
