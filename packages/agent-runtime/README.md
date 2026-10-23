# @vykor/agent-runtime

把查询引擎与运行生命周期、子 agent、本机工具、插件、记忆和工作流接起来。调用方提交消息后，可以等待运行结果、订阅事件，并在结束时释放资源。

## 目录导航

| 目录 | 职责 |
| --- | --- |
| [src/kernel/](./src/kernel/README.md) | 负责推进 agent 任务、接收输入、发送进度通知和管理子任务；所需配置与工具由外层准备并传入 |
| [src/node/](./src/node/README.md) | 接入配置、终端、工具、插件和文件系统，提供默认 Node agent |
| [scripts/](./scripts/README.md) | 构建、发布包检查和执行核心依赖检查 |
| [test-helpers/](./test-helpers/README.md) | 多个测试和其他包共用的插件夹具 |

## 一次运行如何完成

1. `createDefaultNodeAgent()` 读取或接收配置，选择模型客户端，组装执行环境、工具、插件和记忆等能力。
2. `agent.submitMessage()` 创建一次运行，固定本次可用能力，再把消息交给 `@vykor/core` 的查询引擎处理。
3. `FrameworkAgentRun` 把查询引擎事件转换为带有运行归属的事件，通过 `AgentEventBus` 交给订阅者。
4. 需要子 agent 时，子管理器继承当前能力限制，申请工作目录并登记子运行，供调用方等待、继续或取消。
5. 运行结束后交付结果；`agent.close()` 按资源归属停止后台工作并释放当前 agent 拥有的资源。

消息历史留在查询引擎中，运行状态由执行核心管理，本机资源由 Node 组装层持有。会话落盘与服务端调度由外部调用方负责。

## 公开入口

```ts
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { createAgentKernel, AgentEventBus } from "@vykor/agent-runtime/kernel";
import { WorkflowHost } from "@vykor/agent-runtime/node/workflow";
```

`src/index.ts` 提供默认 Node 接入，`src/kernel-entry.ts` 提供执行核心，`src/workflow-entry.ts` 提供工作流宿主。跨包调用优先使用这三个入口。构建将实现打包到 `dist/`，并生成对应类型声明。

## 测试与维护

测试放在被测分类同层的 `__test__/`，专用辅助代码随测试放置。跨包组合回归由仓库的 `tests/agent-integration/` 管理，共用插件夹具保留在 `test-helpers/`。

```bash
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/agent-runtime test:pack
pnpm --filter @vykor/agent-runtime exec vitest run src/node/children/__test__
```

新增模块按职责放入现有分类，更新该分类 README。迁移文件时同步导入、脚本、文档和旧引用清单，并运行 `pnpm check:retired-ui` 与 `pnpm check-docs`。
