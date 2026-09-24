# Memory Write Quality Implementation Plan

> **后续修订（2026-09-24）：** 用户选择自行清空现有项目记忆。Task 3 中为旧无来源事实保留读取兼容和 `unverified` 状态的安排已被取代；当前实现要求每条持久化环境事实都有完整来源，旧格式按文件不可读处理。下面保留原计划与执行记录，供理解当时的变更顺序。

> **For agentic workers:** 执行时使用 `executing-plans`，在当前会话按 Task 1 → 2 → 3 逐项推进。每项先看到定向测试按预期失败，再做最小实现、复跑测试并提交；不调度子 Agent。

**Goal:** 让项目环境事实和长期记忆只保存有明确来源、且没有明显凭据内容的信息；旧的无来源环境事实保留供查看，但不再注入提示词。

**Architecture:** daemon 已保存消息 ID、角色与创建时间；把这些信息传给 `@vykor/personalization`，逐条提取用户消息中的环境事实。`@vykor/memory` 提供一个窄范围的凭据值检测函数，环境事实和长期记忆写入共用它。提示词从项目 `facts.json` 生成可信规则，不直接信任旧 `rules.md` 的缓存文本。

**Tech Stack:** TypeScript、Vitest、现有 Markdown/JSON 文件存储；不新增检索服务。

**Spec:** [记忆归属与写入规则](../../memory-policy.md)，尤其是“标来源”“检查边界”和例子中的助手猜测、API key、旧服务地址。

## Global Constraints

- 环境事实保持当前的项目目录：`$VYKOR_CONFIG_DIR/local_rules/projects/<项目>-<hash>/`。
- 会话来源使用 daemon 已保存的 `sessionId`、消息 `id` 和 `createdAt`；不把原始消息复制进 `facts.json`。
- 不从助手回复、普通工具输出或网页内容自动提取环境事实。工具验证所得事实以后通过单独的、带验证指针的入口接入。
- 凭据检测只针对明确的密钥/令牌形状；拒绝原因和日志不能包含候选原文。不能宣称它能识别所有秘密。
- 无来源的旧项目事实保持原文件，不自动补来源、不自动迁移；从提示词中排除，并在 `/context status` 显示数量。
- 修改一个 Task 只运行相关测试和类型检查；提交钩子的全仓检查作为最终门禁。

## 文件与职责

| 文件 | 这一轮的职责 |
| --- | --- |
| `packages/personalization/src/index.ts` | 按用户消息提取、附来源、保存项目事实；只输出可追溯的规则 |
| `packages/memory/src/sensitive-content.ts`（新建） | 返回凭据风险代码，不返回或记录原文 |
| `packages/memory/src/index.ts`、`packages/agent-runtime/src/memory-runtime.ts` | 在受管记忆写入边界拒绝凭据候选；自动提取跳过被拒记录 |
| `packages/server/src/application/session/session-post-run-maintenance.ts`、`session-maintenance-service.ts` | 把 durable 消息 ID、创建时间和会话 ID 传给环境事实写入 |
| `packages/server/src/application/default-services/context-service.ts` | 报告可信与旧无来源事实各有多少 |
| `packages/prompts/src/prompt-segments-assembly.ts` | 继续按 cwd 读取项目规则；Task 3 验证其不会注入旧缓存 |
| `docs/memory-system.md`、`docs/context-memory-map.md`、`docs/memory-policy.md` | 每项完成后更新实际行为与剩余限制 |

## Task 1：环境事实只取用户消息，并记录真实观察时间

**交付物：** 新增事实能回查到会话与消息；助手猜测不会入库。重复扫描同一条历史消息不改变它的观察时间。

**Files:** `packages/personalization/src/index.ts`、`packages/personalization/src/index.test.ts`、上述两个 server 会话服务及其测试、`docs/memory-system.md`。

**Interfaces:** 给 `SessionMessageLike` 增加可选 `id?: string`、`createdAt?: number`；给 `ExtractedFact` 增加可选 `sourceSessionId?: string`、`sourceMessageId?: string`、`observedAt?: string`，兼容已有 JSON。把 `updateRulesFromSession(messages, cwd)` 改为 `updateRulesFromSession(messages, cwd, sessionId)`；新自动写入只接收带有效消息 ID 和创建时间的 `role: "user"` 消息。

- [x] **Step 1: 写失败测试。** 在 `packages/personalization/src/index.test.ts` 用固定时间 `2026-09-24T00:00:00.000Z` 构造一条用户消息和一条包含另一个 IP 的助手消息；断言 `facts.json` 只有用户 IP，且该条的 `sourceSessionId === "s1"`、`sourceMessageId === "u1"`、`observedAt` 等于固定时间。再次传入相同消息，断言时间不变。测试数据示例：

  ```ts
  const messages = [
    { id: "u1", createdAt: Date.parse("2026-09-24T00:00:00.000Z"), role: "user", content: "ssh ops@10.1.2.3" },
    { id: "a1", createdAt: Date.parse("2026-09-24T00:00:01.000Z"), role: "assistant", content: "ssh ops@10.9.9.9" },
  ];
  updateRulesFromSession(messages, projectDir, "s1");
  expect(loadFacts(projectDir).facts.every((fact) => fact.sourceMessageId === "u1")).toBe(true);
  expect(loadFacts(projectDir).facts.some((fact) => fact.value.includes("10.9.9.9"))).toBe(false);
  ```

- [x] **Step 2: 运行红灯。** 从 `packages/personalization` 运行 `../../node_modules/.bin/vitest.CMD run src/index.test.ts -t "records user fact provenance"`；因助手事实仍入库，实际得到 4 条而非预期 2 条。
- [x] **Step 3: 最小实现。** 在两个 server transcript 映射函数中保留 `message.id`、`message.createdAt`；两个调用点传 `sessionId`。`updateRulesFromSession` 逐条处理合格用户消息，对每条抽出的事实设置上述三个来源字段；不要用 Run 收尾时间。按下面的形状处理消息，并更新现有测试夹具，给原本应写入的用户消息补上固定 ID 与 `createdAt`。已有无来源事实继续留在 `facts.json`，本 Task 不改变读取策略。

  ```ts
  for (const message of messages) {
    if (message.role !== "user" || !message.id ||
        typeof message.createdAt !== "number" || !Number.isFinite(message.createdAt)) continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block as { text?: unknown } | null)?.text)
          .filter((value): value is string => typeof value === "string").join("\n");
    for (const fact of extractFactsFromText(text)) {
      newFacts.push({
        ...fact,
        sourceSessionId: sessionId,
        sourceMessageId: message.id,
        observedAt: new Date(message.createdAt).toISOString(),
      });
    }
  }
  ```
- [x] **Step 4: 运行绿灯。** `personalization` 11 项、两个 server 会话服务合计 13 项测试通过；personalization、server、prompts 类型检查通过；`docs/memory-system.md` 已更新。
- [x] **Step 5: 提交。** `3b701d1b feat: record provenance for environment facts`；暂存差异检查与提交钩子通过。

## Task 2：两类记忆写入共用凭据值检查

**交付物：** 明显的 API key、Bearer token、私钥正文及凭据赋值不能写入项目事实或长期记忆；普通环境变量名和“凭据放在环境变量中”仍可保存。

**Files:** 新建 `packages/memory/src/sensitive-content.ts` 和测试；修改 `packages/memory/src/index.ts`、`index.test.ts`、`packages/agent-runtime/src/memory-runtime.ts`、`memory-runtime.test.ts`、`packages/services/src/memory-extract.ts`、`packages/services/src/__test__/memory-extract.test.ts`、`packages/personalization/src/index.ts`、`index.test.ts`、`packages/personalization/package.json`、`pnpm-lock.yaml`、`docs/memory-policy.md`。

**Interfaces:** 从 `@vykor/memory` 导出 `detectCredentialValue(text: string): "private_key" | "bearer_token" | "key_assignment" | "api_key_prefix" | null`。它只返回风险代码。`@vykor/personalization` 增加对 workspace 包 `@vykor/memory` 的依赖。长期记忆的 `MemoryManager.add/update` 是最后一道防线，自动提取调用方则在逐条写入前跳过被拒候选，以便继续处理同批的安全候选。

- [x] **Step 1: 写失败测试。** 用虚构值 `api_key=example-secret-value`、`Bearer exampletoken123456`、`-----BEGIN PRIVATE KEY-----`、`sk-examplelongtoken123` 验证风险代码；断言 `OPENAI_API_KEY` 和“API key 保存在环境变量中”返回 `null`。另覆盖环境事实、自动语义提取、直接 `MemoryManager.add/update` 和导出的 services 提取辅助入口。
- [x] **Step 2: 运行红灯。** 四个包的相关测试都因缺少检测或仍会落盘而失败；services 辅助入口在第一条凭据被底层拒绝时曾中断同批处理。
- [x] **Step 3: 最小实现。** 新模块返回固定风险代码；`MemoryManager.add/update` 在修改内存和文件前检查正文、标题、描述、标签及字符串型元数据。两个提取入口逐条跳过凭据候选，继续处理安全候选；环境事实在合并前过滤风险值。拒绝时不拼接输入原文。基础检测形状如下：

  ```ts
  export type CredentialRisk = "private_key" | "bearer_token" | "key_assignment" | "api_key_prefix";
  export function detectCredentialValue(text: string): CredentialRisk | null {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return "private_key";
    if (/\bBearer\s+\S{10,}/i.test(text)) return "bearer_token";
    if (/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i.test(text)) return "key_assignment";
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) return "api_key_prefix";
    return null;
  }
  ```
- [x] **Step 4: 运行绿灯。** memory 55 项、personalization 12 项、agent-runtime 8 项、services 9 项测试通过；四包类型检查和架构边界检查通过。文档已明确有限模式检查的边界。
- [x] **Step 5: 提交。** `45241fbe fix: reject credential-like memory values`；提交钩子的全仓类型检查通过。

## Task 3：旧的无来源项目事实不再进入提示词

**交付物：** 已有 `facts.json` 和 `rules.md` 不删除；无来源或含明显凭据值的旧事实仍可在文件中查看，但不进入模型提示词。`/context status` 显示有来源与无来源数量；有来源不等于事实已重新核验。

**Files:** `packages/personalization/src/index.ts`、`index.test.ts`、`packages/prompts/src/index.test.ts`、`packages/server/src/application/default-services/context-service.ts`、`packages/server/src/application/__test__/default-application-services.test.ts`、`docs/context-memory-map.md`、`docs/memory-policy.md`。

**Interfaces:** 增加 `hasFactSource(fact: ExtractedFact): boolean`，要求 `sourceSessionId`、`sourceMessageId` 非空且 `observedAt` 是有效 ISO 时间。`loadLocalRules(cwd)` 从 `loadFacts(cwd).facts.filter(hasFactSource)` 生成模型可见文本；`rules.md` 继续由写入流程生成，供人查看，不再作为提示词的信任来源。`loadFacts(cwd)` 继续返回全量，供诊断与人工整理。

- [x] **Step 1: 写失败测试。** 在同一项目预置一个只有旧 `facts.json`/`rules.md` 的目录；断言 `buildRuntimeSystemPrompt({ cwd })` 不含旧 IP。再加入一条 Task 1 生成的带来源事实；断言提示词只含新值、状态为 `1 sourced, 1 unverified`。现有 prompt 测试夹具已加入带来源的 `facts.json`。
- [x] **Step 2: 运行红灯。** personalization 读入测试、prompts 注入测试和 server 状态测试均因旧缓存进入提示词或状态未分类而失败。
- [x] **Step 3: 最小实现。** `loadLocalRules(cwd)` 只渲染通过来源字段校验的 `facts.json` 条目；没有有来源条目则返回空字符串。`/context status` 分别统计两类事实，不展示其值。磁盘原文件保持不变。来源校验只看已持久化字段，不推测旧记录：

  ```ts
  export function hasFactSource(fact: ExtractedFact): boolean {
    return Boolean(fact.sourceSessionId && fact.sourceMessageId &&
      fact.observedAt && !Number.isNaN(Date.parse(fact.observedAt)));
  }
  export function loadLocalRules(cwd: string): string {
    const sourced = loadFacts(cwd).facts.filter((fact) =>
      hasFactSource(fact) && !detectCredentialValue(fact.value));
    return sourced.length ? factsToRulesMarkdown(sourced).trim() : "";
  }
  ```
- [x] **Step 4: 运行绿灯。** personalization 15 项、prompts 46 项、server 36 项测试通过；三个包类型检查通过。无来源与明显凭据值不进入提示词，文档和诊断输出已核对。
- [x] **Step 5: 提交。** `a62bd56e fix: keep unverified facts out of prompts`；暂存差异检查和提交钩子通过。

## 完成检查

- [x] 三个 Task 各自有红灯、绿灯和提交记录，执行顺序保持不变：`3b701d1b`、`45241fbe`、`a62bd56e`。
- [x] 测试覆盖用户事实、助手猜测、旧数据、安全候选和凭据候选；测试只使用虚构值。
- [x] 三次提交前的差异检查和提交钩子的全仓类型检查通过；文档记录提交后再确认工作区状态。
- [x] 已用 [记忆归属与写入规则](../../memory-policy.md) 的对应例子复核行为。工具验证来源和不同地址是否代表同一服务仍需独立设计；本计划没有自动判断或替换。

这轮计划不自动判断“两个 IP 是否代表同一台服务器”。后续若要替换旧地址，必须先取得可验证的同一对象标识，再设计明确的更新操作；仅按 IP 类型或相似文字删除旧事实会误伤多个真实服务器。
