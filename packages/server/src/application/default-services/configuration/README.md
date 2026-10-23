# 配置与认证默认服务

实现配置读取更新、认证和 Agent 配置档案操作。

## 入口与流程

应用组装调用默认工厂；服务读取当前配置、校验修改并保存，向调用方返回脱敏结果和所需运行影响。

## 状态归属

配置快照由上层共享引用持有，配置文件和认证数据由 host-config、auth 等服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [auth-service.ts](./auth-service.ts) | `createDefaultAuthService` |
| [profile-service.ts](./profile-service.ts) | `createDefaultProfileService` |
| [settings-service.ts](./settings-service.ts) | `SettingsRuntimeImpact`、`AgentEnvironmentService`、`settingsPatchRuntimeImpact`、`createDefaultSettingsService` |

## 测试与维护

配置持久化、认证和档案适配放在这里；模型与供应商规则放在 models。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
