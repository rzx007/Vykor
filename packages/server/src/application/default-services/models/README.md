# 模型与供应商默认服务

管理模型目录、供应商配置、密钥请求头、连接测试和模型容量。

## 入口与流程

模型服务合并目录与自定义配置；供应商服务处理增删与认证配置；连接测试读取已有凭据并调用校验器，返回测试结果。

## 状态归属

供应商配置与凭据分别通过配置、认证服务保存；目录和验证期间的数据由服务实例或调用方持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [catalog-provider-mapping.ts](./catalog-provider-mapping.ts) | `readCatalogProvider`、`catalogProviderModelIds`、`reasoningEffortsFromModel`、`catalogModelEntry` 等 |
| [credential-validation.ts](./credential-validation.ts) | `CredentialValidationInput`、`validateProviderCredential` |
| [model-limit-resolution.ts](./model-limit-resolution.ts) | `ModelLimitKind`、`ModelLimitResolutionInput`、`createModelMetadataResolvers`、`resolveModelLimit` |
| [model-service.ts](./model-service.ts) | `createDefaultModelService` |
| [provider-connection-test.ts](./provider-connection-test.ts) | `storedProviderConnectionFingerprint`、`testStoredProviderConnection` |
| [provider-secret-headers.ts](./provider-secret-headers.ts) | `prepareSecretProviderHeaders` |
| [provider-service.ts](./provider-service.ts) | `createDefaultProviderService`、`ProviderMutationError` |

## 测试与维护

模型映射、供应商兼容处理、连接验证与容量规则放在这里，密钥通过既有认证接口读写。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

createModelMetadataResolvers 的容量和 effort 查询保留创建快照；validateModelSelection 则可接收现有当前配置读取器，复用会话的 validateRequestSelection。子环境申请前与每轮模型准备均经同一端口验证；目录不可用或模型已撤销时明确失败，不静默换模型。

`createModelMetadataResolvers` 还提供 `resolveModelImageSupport`，复用附件的模型和供应商能力判断。每轮按所选模型查询，只有明确支持原生图片时返回 `true`；纯文本模型和能力未知的模型返回 `false`。目录和自定义供应商信息沿用创建时的快照，运行层将结果交给查询引擎处理本次请求中的历史图片。
