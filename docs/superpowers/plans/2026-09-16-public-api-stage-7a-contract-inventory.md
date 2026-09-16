# Stage 7A：公共契约清单与旧调用扫描实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。7A 只运行建立可信门禁所需的 scanner/contract 自测，包级与全仓验证留到 7F。

**目标：** 建立可审查的 Client 公共契约清单、可靠的旧平铺调用 AST 扫描、runtime export 快照和代表性 type consumer fixture，为 7B–7F 提供真实基线。

**架构：** 使用仓库已有 `typescript` Compiler API 解析各 workspace tsconfig，通过类型信息识别 `OpenHarnessClient` 兼容方法调用；人工维护兼容方法与替代入口映射，机器负责验证映射和调用位置。runtime export 由 Vitest 锁定，type-only export 由穷尽清单加独立编译 fixture 约束。

**技术栈：** TypeScript Compiler API、Node test、Vitest、现有 architecture/docs 脚本。

---

## 文件结构

- 创建：`scripts/client-public-api-contract.json` —— 根导出、Client properties/getters/methods、分类、替代入口和弃用信息的唯一清单。
- 创建：`scripts/client-legacy-calls.mjs` —— 复用 TypeScript Compiler API，输出生产与测试旧调用、成员引用明细。
- 创建：`scripts/client-legacy-calls.test.mjs` —— 覆盖直接调用、别名、成员字段、await factory、解构和误报场景。
- 创建：`packages/client/src/__test__/public-api.test.ts` —— runtime export 快照与契约清单一致性测试。
- 创建：`tests/client-public-api/consumer.ts` —— 代表性外部消费者类型 fixture。
- 创建：`tests/client-public-api/tsconfig.json` —— 独立编译配置。
- 修改：`scripts/architecture-boundaries.mjs` —— 调用新扫描器并输出新旧指标。
- 修改：`scripts/architecture-boundaries.test.mjs` —— 验证生产/测试分类与完成门禁。
- 修改：`scripts/architecture-baseline.json` —— 保留旧 79 历史值，新增 AST 基线字段。
- 修改：`package.json` —— 增加 `check:client-api`，并由根 `check:architecture` 固定调用。
- 修改：`docs/architecture-migration-status.md` —— 记录 7A 新基线和扫描范围，不提前标记 Stage 7 完成。

## 任务 1：建立穷尽契约清单

- [ ] 从 `packages/client/src/index.ts`、`packages/client/src/transport/http-client.ts`、`packages/client/src/resources/*.ts` 提取实际 runtime/type exports、Client public properties/getters/methods。
- [ ] 在 `scripts/client-public-api-contract.json` 为每一项填写：

```json
{
  "name": "getSession",
  "kind": "client-method",
  "classification": "compatibility",
  "replacement": "sessions.get",
  "deprecatedSince": null,
  "deprecatedCarrierRelease": null,
  "retentionCarrierRelease": null,
  "removeIn": "stage-8-after-release-gate"
}
```

- [ ] 分类只允许 `long-term`、`advanced`、`compatibility`、`retained-unclassified`；任何空分类使检查失败。
- [ ] 明确 `health -> protocol.health`、`capabilities -> protocol.capabilities`；`transport/sse/baseUrl/token/fetchImpl` 标 `retained-unclassified`。
- [ ] 确认清单包含根入口的 `createPromptRequestId`、`normalizeDaemonBaseUrl`、`streamServerSentEvents` 和全部 type-only exports。
- [ ] 使用 TypeChecker 对 `packages/client/src/index.ts` 的 module symbol 调用 `getExportsOfModule`；遇到 re-export alias 先用 `getAliasedSymbol` 解析目标，再按 resolved SymbolFlags 区分 runtime/type-only，自动与清单逐项比较；遗漏、新增和分类不符都失败。

## 任务 2：实现 TypeScript AST 旧调用扫描器

- [ ] 导出纯函数 `scanClientLegacyCalls(options)`，返回：

```ts
type LegacyReference = {
  file: string;
  line: number;
  column: number;
  method: string;
  replacement: string;
  scope: "production" | "compatibility-test" | "other-test";
  receiver: "direct" | "alias" | "member" | "await-factory" | "destructured";
  usage: "call" | "value-reference" | "destructure" | "type-index";
};
```

- [ ] 使用各 workspace `tsconfig.json` 创建 Program；通过 TypeChecker 确认 receiver 类型包含 `OpenHarnessClient`，不按变量名猜测。
- [ ] 对 property call、属性取值/传递、element access、解构 alias 和 `OpenHarnessClient["method"]` 类型索引做符号追踪。
- [ ] 对 `Pick<OpenHarnessClient, "compatMethod">` 等 mapped type，从 transient property symbol/declaration/alias target 追溯回 `OpenHarnessClient` 的兼容成员；不能只检查 receiver 表面类型名称。
- [ ] 已确认来源是 `OpenHarnessClient` 但无法解析具体成员的 production diagnostic 直接令门禁失败；动态字符串属性列入人工审计清单。
- [ ] 从契约清单读取 compatibility method names，禁止在扫描器重复维护第二份列表。
- [ ] 排除 `packages/client/src/transport/http-client.ts` facade 自身；将 `http-client.test.ts` 的转发测试归为 `compatibility-test`，其他 test/spec 归为 `other-test`。
- [ ] 默认扫描设计规格 6.7 矩阵中的 packages/apps；同时扫描所有生产 `.ts/.tsx` 对 `@openharness/client` 的导入，避免新文件漏网。

## 任务 3：锁定扫描形态

- [ ] 在 `scripts/client-legacy-calls.test.mjs` 建立临时 TypeScript fixture，至少覆盖：

```ts
client.getSession("s1");
const api = client; api.listJobs();
this.client.replyPermission("p1", input);
(await clientFactory()).listPlugins({ cwd });
const { getSession } = client; getSession("s1");
type CancelResult = ReturnType<OpenHarnessClient["cancelJob"]>;
const fn = client.getSession;
type Capability = Pick<OpenHarnessClient, "capabilities">;
declare const narrowed: Capability; narrowed.capabilities();
declare function invoke(callback: (client: Capability) => void): void;
invoke((client) => client.capabilities());
client.sessions.get("s1"); // 不应报告
unrelated.getSession("s1"); // 不应报告
```

- [ ] 断言每种旧调用报告准确 file/line/method/replacement/scope。
- [ ] 断言兼容类型索引和属性取值会报告；Resource 调用及同名非 Client 方法不误报。
- [ ] 断言契约清单新增 compatibility 方法后扫描器自动识别，无需修改扫描器源码。

## 任务 4：接入架构指标

- [ ] `architecture-boundaries.mjs` 保留 `clientLegacyFlatCalls: 79` 为 `clientLegacyRegexHistoricalBaseline`，不再作为完成门禁。
- [ ] 新增输出：

```json
{
  "clientLegacyProductionCalls": 0,
  "clientLegacyProductionReferences": 0,
  "clientLegacyCompatibilityTestCalls": 0,
  "clientLegacyOtherTestCalls": 0
}
```

- [ ] 初次运行 `node scripts/client-legacy-calls.mjs --json`，把真实起始值写入 baseline；同时保存按文件/方法明细到命令输出，不提交临时报告文件。
- [ ] 架构检查规则：生产值只能下降；compatibility-test 可保持；other-test 应在相应消费端迁移时下降。
- [ ] `--write-baseline` 只允许显式执行，普通检查不得自动放宽基线。

## 任务 5：锁定 runtime export 与代表性类型消费

- [ ] `public-api.test.ts` 动态导入 `../index.js`，将排序后的 runtime keys 与契约清单中 runtime exports 比较。
- [ ] 测试还应反射 `OpenHarnessClient.prototype`，确认 compatibility method、getter 和清单一致；构造器实例 properties 用注入 fetch 构造后核对。
- [ ] 用 TypeChecker 自动枚举根入口全部 exports，验证 runtime/type-only 分类和清单完全一致。
- [ ] `consumer.ts` 从 `@openharness/client` 导入 Client、关键错误、协议检查、每个 Resource 代表性输入/输出类型、state/sync 能力，并实际写出能通过类型检查的调用。
- [ ] fixture 同时引用一个 deprecated 平铺方法，证明 Stage 7 仍兼容；不要使用 `@ts-ignore`、`any` 或相对源码导入。
- [ ] `tsconfig.json` 使用 `noEmit`、`strict`、`moduleResolution` 与项目一致，并通过 workspace paths 解析包根入口。
- [ ] `package.json` 新增：

```json
"check:client-api": "tsc -p tests/client-public-api/tsconfig.json && node --test scripts/client-legacy-calls.test.mjs && pnpm --filter @openharness/client exec vitest run src/__test__/public-api.test.ts"
```
- [ ] 根 `package.json` 将脚本明确改为 `"check:architecture": "pnpm check:client-api && node scripts/architecture-boundaries.mjs"`；这样固定串联 consumer 编译、scanner test、runtime/type-only contract comparison 和架构扫描。

## 任务 6：建立基线与提交（暂不运行包级测试）

- [ ] 运行 `node --test scripts/client-legacy-calls.test.mjs scripts/architecture-boundaries.test.mjs`，预期全部通过。
- [ ] 只运行建立可信基线必需的 scanner/contract 自测与 `pnpm check:client-api`；包级测试、根 architecture/docs/diff 统一留到 7F。
- [ ] 更新迁移状态：记录旧正则历史值 79、新 AST 的 production/test 起始值、扫描限制和命令；只标 7A 完成，7B–7F 未开始。
- [ ] 提交：

```bash
git add package.json scripts packages/client/src/__test__/public-api.test.ts tests/client-public-api docs/architecture-migration-status.md
git commit -m "test(client): lock public api contract"
```

## 验收标准

- 契约清单覆盖所有根 runtime/type exports 和 Client public surface；
- AST fixtures 能识别 5 种旧调用形态且不误报 Resource/同名方法；
- 新 AST 指标成为唯一 Stage 7 完成门禁；
- 真实生产基线和测试基线已记录；
- runtime/type-only export 与代表性 type consumer 检查进入固定根门禁；
- 没有迁移任何业务调用，也没有删除或 deprecated 任何 API。
