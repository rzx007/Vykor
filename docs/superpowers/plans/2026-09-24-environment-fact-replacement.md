# 环境事实旧值替换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让用户在当前项目精确选择一条旧环境事实并写入新值；旧值在历史重扫后仍失效，来源和关联键可查看。

**架构：** `@vykor/personalization` 负责事实状态、校验、原子持久化和提示词过滤；daemon 提供项目范围的 `/facts` 读写接口并取得 cwd 写入锁；客户端用 `/facts` 命令调用接口。观察日期提示已经完成，本计划不增加自动过期或虚假的核验时间。

**技术栈：** TypeScript、Node `fs`、Hono、Vitest；复用现有包和 `facts.json`，不加依赖或数据库表。

**设计依据：** [环境事实时效与旧值替换设计](../specs/2026-09-24-environment-fact-freshness-and-replacement-design.md)。执行前确认工作区状态；每个任务单独做红灯、绿灯、审查和提交。

**执行进度：** 用户明确选择直接在 `main` 执行。任务 1 的代码与测试已完成，待提交；任务 2–4 未开始。

---

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `packages/personalization/src/index.ts`、`index.test.ts`、`packages/prompts/src/index.test.ts` | 状态、来源、替换、重扫防复活、提示词过滤的权威逻辑和真实文件 / prompt 测试 |
| `packages/server/src/http/routes/facts.ts`、`facts.test.ts` | cwd 范围的列表与替换 HTTP 边界、输入及错误码、写入锁 |
| `packages/server/src/http/server.ts` | 装配 `/facts` 路由 |
| `packages/client/src/resources/system-resource.ts` | 两个 HTTP 资源方法及客户端可见的响应类型 |
| `packages/client/src/commands/session-commands.ts`、`__test__/session-commands.test.ts` | `/facts list`、`/facts replace` 的解析和呈现 |
| `packages/server/src/commands/commands.ts`、`__test__/commands.test.ts` | 斜杠命令发现与帮助 |
| `docs/memory-system.md`、`docs/context-memory-map.md`、`docs/memory-policy.md` | 写清已落地行为与剩余限制 |

## 任务 1：事实状态与安全替换

**文件：** 修改 `packages/personalization/src/index.ts`、`packages/personalization/src/index.test.ts`、`packages/prompts/src/index.test.ts`。

- [ ] **步骤 1：先写失败测试。** 使用临时 `VYKOR_CONFIG_DIR` 的真实文件，先存入 `ssh_host:ops@10.1.2.3`、`ip_address:10.1.2.3` 和另一台主机。调用拟新增的 `replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4", { sessionId: "s1" })`，断言只有选中键被取代、结果列出仍含旧 IP 的 `ip_address:10.1.2.3`、新值有 `manual_replace` 来源。重复提交同一操作，断言操作 ID 不变。再以原用户消息调用 `updateRulesFromSession()` 并重新 `loadFacts()`，断言旧键仍为 `superseded`，`loadLocalRules()` 不含旧 SSH 值。分别以不存在旧键、不同类型格式、凭据值和已存在目标键测试“抛错且文件字节不变”。测试还要覆盖损坏文件不被覆盖、其他项目不受影响。在 `packages/prompts/src/index.test.ts` 加真实 prompt 回归：即使 `rules.md` 缓存仍含旧 SSH 值，组装后的 prompt 只含新 SSH 值。

  核心断言示例：

  ```ts
  const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4", { sessionId: "s1" });
  expect(result.relatedActiveKeys).toContain("ip_address:10.1.2.3");
  updateRulesFromSession(oldMessages, projectDir, "s1");
  expect(loadFacts(projectDir).facts.find((fact) => fact.key === result.oldKey)?.status).toBe("superseded");
  expect(loadLocalRules(projectDir)).not.toContain("ops@10.1.2.3");
  ```

- [ ] **步骤 2：确认红灯。** 在 `packages/personalization` 执行 `../../node_modules/.bin/vitest.CMD run src/index.test.ts -t "replaceFact"`；在 `packages/prompts` 执行 `../../node_modules/.bin/vitest.CMD run src/index.test.ts -t "superseded"`。预期因导出函数不存在或旧值仍注入而 FAIL，不是测试配置错误。

- [ ] **步骤 3：实现最少的持久化状态。** 为事实增加可选 `status: "superseded"` 和 `replacement: { byKey: string; operationId: string; at: string }`；无 `status` 表示有效，这让目前已写出的有来源事实继续可读。给手动新事实增加 `manualSource: { operationId: string; oldKey: string; at: string; sessionId?: string }`，来源校验接受现有用户消息来源或完整的手动替换来源，不伪造消息 ID。旧记录保留原消息来源。`loadLocalRules()` 和 `factsToRulesMarkdown()` 只使用有效事实；`mergeFacts()` 不允许历史重扫覆盖 `superseded` 键。`replaceFact()` 从旧记录继承 `type`、`label`、`confidence`，对十种现有事实类型校验新值的规范形状，并调用已有 `detectCredentialValue()`。旧键已取代且目标相同则返回现有结果；目标不同则报冲突。先原子写 `facts.json`，再更新 `rules.md`；缓存更新失败在结果中标为 warning，不回滚已经成功的权威文件。

  结果形状固定为：

  ```ts
  type ReplaceFactResult = {
    oldKey: string;
    newKey: string;
    operationId: string;
    relatedActiveKeys: string[];
    cacheWarning?: string;
  };
  ```

  `relatedActiveKeys` 只列仍含旧值的其他有效键，不替用户改它们。校验失败用带 `code` 的领域错误表示 `INVALID_VALUE`、`NOT_FOUND`、`CONFLICT`、`UNREADABLE`；错误消息不回显凭据。

  关键过滤要发生在共同入口，而非只改一处展示：

  ```ts
  const isActiveFact = (fact: ExtractedFact) => fact.status !== "superseded";
  const active = loadFacts(cwd).facts.filter(isActiveFact);
  const old = byKey.get(newFact.key);
  if (old?.status === "superseded") continue;
  ```

- [ ] **步骤 4：确认绿灯并提交。** 运行 `../../node_modules/.bin/vitest.CMD run src/index.test.ts` 和 `../../node_modules/.bin/tsc.CMD --noEmit`（工作目录 `packages/personalization`），并运行 `../../node_modules/.bin/vitest.CMD run src/index.test.ts`（工作目录 `packages/prompts`）；检查 `git diff --check`，提交生产代码与两个测试文件。

## 任务 2：daemon 读写入口

**文件：** 创建 `packages/server/src/http/routes/facts.ts`、`facts.test.ts`；修改 `packages/server/src/http/server.ts`。

- [ ] **步骤 1：先写失败的路由测试。** 用临时项目和 `VYKOR_CONFIG_DIR`，通过真实 personalization 文件读取测试 `GET /facts?cwd=...` 返回有效及被取代记录；`POST /facts/replace` 请求体为 `{ cwd, oldKey, newValue, sessionId? }`。断言未给 cwd/newValue 返回 400、运行中无法取得 cwd mutation lease 返回 409、旧键缺失返回 404、无效值返回 400、目标冲突返回 409、损坏文件返回 500 且不写入。成功后读取提示词确认只见新键，并检查关闭该 cwd 的 runtime；失败时不关闭。测试 `finally` 释放 lease。

  请求示例：

  ```ts
  const response = await app.request("/facts/replace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4" }),
  });
  expect(response.status).toBe(200);
  ```

- [ ] **步骤 2：确认红灯。** 在 `packages/server` 执行 `../../node_modules/.bin/vitest.CMD run src/http/routes/facts.test.ts`；预期路由不存在或状态码断言失败。

- [ ] **步骤 3：接入现有模式。** `createFactsRoutes({ control })` 使用 `loadFacts()`、`replaceFact()`，像 `routes/memory.ts` 一样先校验请求、调用 `acquireCwdMutation(cwd)`、在 `finally` 释放。列表只读，不获取写锁；写操作在 lease 内调用领域函数，再 `closeRuntimesForCwd(cwd)`，按上一步的错误码返回。`server.ts` 挂载 `this.app.route("/facts", createFactsRoutes({ control: this.application.control }))`。避免新增单实现 service 层。

  写入边界的骨架：

  ```ts
  const lease = context.control.acquireCwdMutation(body.cwd);
  if (!lease) return errorResponse(409, "Project has an active run");
  try {
    const result = replaceFact(body.cwd, body.oldKey, body.newValue, { sessionId: body.sessionId });
    await context.control.closeRuntimesForCwd(body.cwd);
    return jsonResponse({ result });
  } finally {
    lease.release();
  }
  ```

- [ ] **步骤 4：确认绿灯并提交。** 运行 `../../node_modules/.bin/vitest.CMD run src/http/routes/facts.test.ts`、`../../node_modules/.bin/tsc.CMD --noEmit`（工作目录 `packages/server`），检查 diff 后提交本任务文件。

## 任务 3：用户可用的 `/facts` 命令

**文件：** 修改 `packages/client/src/resources/system-resource.ts`、`packages/client/src/commands/session-commands.ts`、`packages/client/src/commands/__test__/session-commands.test.ts`、`packages/server/src/commands/commands.ts`、`packages/server/src/commands/__test__/commands.test.ts`。

- [ ] **步骤 1：先写失败测试。** 通过真实命令分发测试 `/facts list`：输出键、状态、观察日期和来源；测试 `/facts replace ssh_host:ops@10.1.2.3 => ops@10.1.2.4`：传入准确 cwd、旧键、新值和现有 sessionId，并显示操作 ID 及 `relatedActiveKeys` 提醒。缺少 `=>`、空旧键/新值只显示用法且不发写请求。命令目录测试验证 `/facts` 可被发现，说明与 `/memory` 不同。

  命令请求断言示例：

  ```ts
  await dispatchSessionCommand({ name: "/facts", args: "replace ssh_host:ops@10.1.2.3 => ops@10.1.2.4" }, host);
  expect(replaceFactRequest).toHaveBeenCalledWith({
    cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4", sessionId: "s1",
  });
  ```

- [ ] **步骤 2：确认红灯。** 分别执行 `../../node_modules/.bin/vitest.CMD run src/commands/__test__/session-commands.test.ts -t "/facts"`（`packages/client`）及 `../../node_modules/.bin/vitest.CMD run src/commands/__test__/commands.test.ts -t "/facts"`（`packages/server`）；预期缺少命令处理而失败。

- [ ] **步骤 3：实现资源与命令。** `SystemResource` 增加 `listFacts({cwd})` 请求 `GET /facts` 和 `replaceFact({cwd,oldKey,newValue,sessionId?})` 请求 `POST /facts/replace`；客户端本地 DTO 描述响应，不让 `@vykor/client` 依赖 Node-only personalization 包。命令以第一个 `=>` 分开旧键与新值，`list` 用现有 `readPresentation()`，`replace` 用 `emit()`；只给 `/facts list` 走只读呈现。`BUILTIN_SESSION_COMMANDS` 增加 `/facts`、参数提示和用途。

  解析形状：

  ```ts
  const body = slash.args.slice("replace".length).trim();
  const separator = body.indexOf("=>");
  const oldKey = separator < 0 ? "" : body.slice(0, separator).trim();
  const newValue = separator < 0 ? "" : body.slice(separator + 2).trim();
  if (!oldKey || !newValue) { emit("Usage: /facts replace <old-key> => <new-value>"); return "handled"; }
  ```

- [ ] **步骤 4：确认绿灯并提交。** 运行客户端与服务端上述完整测试文件，并分别运行两包的 `../../node_modules/.bin/tsc.CMD --noEmit`；检查 diff 后提交本任务文件。

## 任务 4：端到端回归与文档

**文件：** 修改 `docs/memory-system.md`、`docs/context-memory-map.md`、`docs/memory-policy.md`；按回归结果修正任务 1–3 涉及文件。

- [ ] **步骤 1：核对任务 1 的端到端回归。** 运行 prompt 测试，核对旧缓存不进入提示词、新值带观察日期、其他项目不泄露；发现遗漏就先写能复现的失败测试，修复后重跑。不要添加只为覆盖率而存在的断言。

- [ ] **步骤 2：更新用户文档。** 把已实现的 `/facts list`、`/facts replace <旧键> => <新值>`、来源含义、同地址其他键提醒和防复活机制写入三份现有文档；明确没有 TTL、后台核验或自动服务身份判断。将设计文档状态由“设计待审”改为“已实施”，仅在所有验收项通过后执行。

- [ ] **步骤 3：最终验证与提交。** 分别运行 personalization、server 路由、client 命令、prompts 的受影响 Vitest 文件，运行根目录 `node scripts/check-docs.mjs`、`node scripts/architecture-boundaries.mjs`、`git diff --check`，再运行根目录 `pnpm check-types`。逐条核对设计文档五项验收；发现缺口先修复并重跑受影响检查，再提交文档和回归测试。
