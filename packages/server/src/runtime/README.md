# 活跃执行与运行环境

管理会话运行的活动资源，并提供运行环境和密钥配置接口。

## 入口与流程

`SessionRunCoordinator` 协调排队、中断与执行资源；环境组装接入终端和隔离能力；配置函数检查运行环境、分发方式与密钥。

## 状态归属

运行中的等待与取消由协调器持有，环境由对应宿主管理，配置和密钥通过既有服务保存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [run-coordinator.ts](./run-coordinator.ts) | `RunInterruptedError`、`SessionRunWorkContext`、`EnqueueRunOptions`、`EnqueueRunResult` 等 |
| [runtime-secrets.ts](./runtime-secrets.ts) | `runtimeSecretsRevision`、`loadRuntimeSecrets`、`saveRuntimeSecrets` |
| [runtime-settings.ts](./runtime-settings.ts) | `environmentFingerprint`、`inspectRuntimeEnvironment`、`validateRuntimeEnvironmentConfig`、`saveRuntimeEnvironment` 等 |
| [session-execution-environment.ts](./session-execution-environment.ts) | `createSessionEnvironmentAcquirer` |
| [session-settings-root.ts](./session-settings-root.ts) | `sessionSettingsRoot` |

## 测试与维护

活跃执行协调与环境适配放在这里；持久运行的业务准入和结算放在 application/session/execution。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
