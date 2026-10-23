# 默认服务工厂

提供应用接口的默认实现，并共享当前配置引用。

## 入口与流程

`index.ts` 汇总各工厂供应用组装；`shared.ts` 负责读取、脱敏、合并和保存配置；各子目录实现对应业务接口。

## 状态归属

`DaemonSettingsRef` 持有当前配置快照；凭据、配置文件及其他持久记录由对应服务保存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [query-models.ts](./query-models.ts) | `AgentEnvironmentCapabilities` |
| [shared.ts](./shared.ts) | `DaemonSettingsRef`、`sanitizeSettings`、`readCurrentSettings`、`mergeSettingsPatch` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [configuration/](./configuration/README.md) | 实现配置读取更新、认证和 Agent 配置档案操作。 |
| [models/](./models/README.md) | 管理模型目录、供应商配置、密钥请求头、连接测试和模型容量。 |
| [extensions/](./extensions/README.md) | 实现插件、市场、Hook 和输出风格的应用接口。 |
| [memory/](./memory/README.md) | 接入上下文查看、记忆读写和后台记忆整理。 |
| [projects/](./projects/README.md) | 实现 Git 操作和项目初始化的默认应用接口。 |

## 测试与维护

工厂实现按下方职责分类；仅跨分类共用的配置引用与纯辅助函数留在本层。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
