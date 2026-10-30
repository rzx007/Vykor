# Agent 生命周期客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将公开 SDK 收敛为连接已有 daemon 的完整 Agent 生命周期客户端，产品业务归入私有应用层。

**Architecture:** `@rzx/client` 拥有协议、生命周期资源和唯一同步流程；`@vykor/application-client` 组合核心资源与私有业务资源。产品迁移到私有包，独立安装的 SDK 不包含应用功能。

**Tech Stack:** TypeScript、ESM、pnpm workspace、Vitest、esbuild、rollup-plugin-dts。

**Spec:** `docs/superpowers/specs/2026-10-30-agent-client-lifecycle-design.md`

## Global Constraints

- Node.js >= 20.3，主入口浏览器安全，运行时不依赖未发布 workspace 包。
- 默认连接已有 daemon，不调用 Service.ensure 或改变服务端配置。
- 不修改 daemon 的协议、状态机或持久化规则，不触碰主工作区未提交的桌面改动。
- 测试放分类下的 `__test__/`；分类维护 README。所有迁移更新精确引用登记。

## Task 1: 公开生命周期边界与结果等待

**Files:** `packages/client/src/{index.ts,transport/http-client.ts,resources,types,state}`、`packages/client/src/__test__/lifecycle-boundary.test.ts`、`packages/client/src/state/__test__/wait-for-run.test.ts`。

**Interfaces:** 保留 VykorClient 与核心 Resource；新增只读 RuntimeResource 和 `waitForRun(client, { sessionId, runId, signal })`，返回 `{ run, messages }`。

- [x] 先验证 `new VykorClient({ baseUrl }).notes` 等应用资源不存在、构造不产生请求；测试先在原代码断言失败。
- [x] 收敛实例资源为 protocol/runtime/sessions/permissions/attachments/jobs/events，拆出业务根导出和管理方法。
- [x] runtime 直接读取 `/models`、`/agent-personas`、`/skills`、`/sessions/:id/mcp`，保持 signal 传递及协议握手。
- [x] 给 waitForRun 写已完成快照、流式完成、失败终态、取消和目标 Run 区分的测试；复用 syncEvents 和现有选择函数，不新增第二套状态归并。
- [x] 运行 SDK 类型检查、单元测试和真实安装包验证。

## Task 2: 私有业务客户端

**Files:** 新增 `packages/application-client/{package.json,tsconfig.json,README.md,src}`；迁移 `packages/client/src/{commands,resources/{configuration,workspace,plugins},types}` 中的业务实现和对应测试。

**Interfaces:** 私有包继续导出产品所用的 `VykorClient`、原业务类和类型，并从公开 SDK 复用核心 API。

- [x] 添加私有客户端构造及业务请求用例，确认原代码缺少该包时无法满足。
- [x] 移动业务 Resource、命令、策略和业务类型，不复制 transport/reducer/sync。
- [x] 用公开 SessionResource/AttachmentResource 的子类承接 worktree 绑定清理和附件存储管理；独立命名构造参数避免与父类私有字段冲突。
- [x] 核对包 `private: true`、只向 SDK/Protocol 依赖，更新目录 README，运行私有包类型检查和业务测试。

## Task 3: 产品调用方与构建迁移

**Files:** `apps/{cli,frontend,desktop}`、`tests/{server-client,browser-client,client-public-api}`、workspace manifests/lock、构建与别名配置。

**Interfaces:** 产品的现有 VykorClient 导入改为私有包；生命周期验收继续调用公开 SDK。

- [x] 产品根导入迁移到 `@vykor/application-client`，显式 service 导入保持来自公开 SDK。
- [x] 业务集成测试迁移私有包，公开 SDK 编译用例加入 `client.notes`、NoteRecord 等不可见的负例。
- [x] 调整 bundler、测试 alias、workspace 依赖及包边界，使私有应用包参与产品构建。
- [x] 运行相关产品类型检查和构建；检查 SDK 对私有包不存在依赖。

## Task 4: 公开契约、发布产物与文档

**Files:** `scripts/client-public-api-contract.json`、`scripts/architecture-*`、`scripts/retired-native-ui-allowlist.json`、`packages/client/scripts/verify-pack.mjs`、各层 README、`docs/client-sdk.md`。

**Interfaces:** 发布包只暴露生命周期资源/类型，继续支持 root 与 service 两个入口。

- [x] 更新公开 API 清单，安装包消费者增加业务 API/类型不可用负例，并检查 bundle/declaration 没有业务模块。
- [x] 调整架构规则和缓存输入为 SDK → Protocol、Application Client → SDK/Protocol、产品 → Application Client；禁止 SDK 反向导入。
- [x] 更新分类导航、生命周期使用示例、既有 daemon 的连接说明和私有应用层说明。
- [x] 运行 `pnpm check:architecture`、`pnpm check:retired-ui`、`pnpm check-docs` 和客户端/应用层/相关集成测试，最后独立复核整个变更。
