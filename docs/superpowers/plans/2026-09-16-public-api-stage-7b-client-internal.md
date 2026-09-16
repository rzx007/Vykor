# Stage 7B：Client 内部消费者迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。完成本波生产迁移并核对 AST 明细；类型检查和测试统一留到 7F。

**目标：** 让 `@openharness/client` 自己的 commands/state 代码只依赖 Protocol/Resource 窄能力，除 facade 和兼容测试外不调用平铺入口。

**架构：** commands 根据实际行为接收 `protocol/system/sessions/...` 结构能力；sync/controller 保持现有 `SyncEventsClient`。不为了收窄类型创建第二个 Client 门面，也不改变命令与同步行为。

**技术栈：** TypeScript、Vitest、Client Resources、Stage 7A AST 扫描器。

---

## 文件结构

- 修改：`packages/client/src/commands/session-commands.ts` —— 替换残余平铺方法和完整 Client capability。
- 修改：`packages/client/src/commands/__test__/session-commands.test.ts` —— fixture 改成 Resource 形状，保持行为断言。
- 审计：`packages/client/src/state/sync.ts`、`session-sync-controller.ts` —— 确认已使用窄接口，不重复重构。
- 修改：`packages/client/src/state/__test__/*.test.ts` —— 只在仍构造平铺 mock 时迁移 fixture。
- 修改：`scripts/architecture-baseline.json`、`docs/architecture-migration-status.md` —— 记录本波下降值。

## 任务 1：读取 7A 明细并冻结范围

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path packages/client/src`。
- [ ] 将输出逐项分为 commands、state、facade；`http-client.ts` facade 不迁，其他生产调用必须进入本计划。
- [ ] 在实现记录中保存“旧方法 → Resource/Protocol 方法”表，例如 `health -> protocol.health`、`getSettings -> system.getSettings`。
- [ ] 如果 state 已为零旧调用，只记录审计证据，不为了产生 diff 改写已正确代码。

## 任务 2：收窄 SessionCommandHost

- [ ] 根据 `dispatchSessionCommand` 实际访问定义 capability，优先引用 Resource 方法签名：

```ts
export interface SessionCommandClient {
  protocol: Pick<ProtocolClient, "health">;
  system: Pick<SystemResource, "getSettings" | "patchSettings" | "listCommands">;
  sessions: Pick<SessionResource, "compact" | "rewind" | "remember" | "export" | "getUsage">;
  providers: Pick<ProviderResource, "listModels" | "listProviders">;
  plugins: Pick<PluginResource, "list" | "reload">;
  development: Pick<DevelopmentResource, "listSkills" | "listHooks" | "getGitDiff" | "getGitBranch" | "getGitStatus" | "gitCommit">;
  jobs: Pick<JobResource, "list" | "createBackgroundShell">;
}
```

- [ ] 只保留实际调用的方法；上述清单必须根据代码核对后裁剪，不能照抄多余能力。
- [ ] 把每个 `client.flatMethod()` 替换为对应命名属性；参数和错误处理原样保留。
- [ ] `health` 使用 `protocol.health`，不得错误放到 `system`。
- [ ] 不改 slash command 文案、dispatch 顺序、presentation request 或返回 union。

## 任务 3：迁移测试 fixture

- [ ] 将测试中完整 Client mock 改成 `protocol/system/sessions/...` 嵌套对象。
- [ ] 每个命令继续断言调用参数、返回 outcome、错误消息；不要把“调用了某个 mock”替代用户可观察断言。
- [ ] 增加类型级测试：缺少命令实际需要的 Resource 方法时 fixture 编译失败；不使用 `as unknown as OpenHarnessClient`。
- [ ] 保留一处兼容 facade 测试在 `http-client.test.ts`，本计划不删除它。

## 任务 4：审计 state/sync

- [ ] 确认 `SyncEventsClient` 只包含 `sessions.getState` 和 `events.list/stream`。
- [ ] 确认 `SessionSyncControllerOptions.client` 使用该窄接口而非 `OpenHarnessClient`。
- [ ] 检查 `hydrateState`、reducer、selectors 不导入 transport、Resource class 或 Client。
- [ ] 如果 7A AST 报告 state 旧调用，按报告最小迁移；否则不改 state 文件。

## 任务 5：静态清单核对与提交

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path packages/client/src`，预期 facade 排除后调用和成员引用均为 0。
- [ ] 本波不运行包级类型检查、测试、architecture 或 docs；这些统一留到 7F，提交说明注明“尚未统一验证”。
- [ ] 更新 baseline，只允许 production 数下降；记录 state 审计是否产生代码变更。
- [ ] 若审计确认已全部使用 Resource 且没有代码 diff，不制造空提交；把审计结果记录到迁移状态后继续 7C。
- [ ] 提交：

```bash
git add packages/client/src/commands packages/client/src/state scripts/architecture-baseline.json docs/architecture-migration-status.md
git commit -m "refactor(client): migrate internal resource consumers"
```

## 验收标准

- Client commands/state 生产旧调用和旧成员引用为 0；
- commands 接收实际 Resource/Protocol capability，不接受完整 Client；
- state 保持既有 snapshot/cursor/reconnect 行为；
- 已完成 AST 清单核对，完整类型与测试结果由 7F 给出；
- facade 与兼容测试仍保留。
