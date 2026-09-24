# MCP OAuth 第一阶段补全 — 审查者 prompt

> 把本文档整体作为 prompt 交给审查者（人或审查 Agent）。只读审查，不要修改代码、不要提交、不要创建 PR。

你是一名资深代码审查者，请审查 Vykor 仓库中「MCP OAuth 第一阶段补全」的实现。

## 背景资料（先读）

- 设计规格（最高优先级）：`docs/superpowers/specs/2026-09-21-mcp-oauth-phase-1-completion-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-21-mcp-oauth-phase-1-completion.md`
- 本次实现范围：commit `0844673c` 到 `7173b898`（共 10 个提交）。

注意：`git log 2890d051..HEAD` 里还夹着**与本任务无关的并发提交**（`62750e89`、`6548f045`、`5cb1fce7`、`e55ad864`、`c8617115`）。请只审查上述 10 个 MCP OAuth 提交，不要审查、也不要修改这些无关提交，不要改写 git 历史。

本次实现提交（按时间顺序）：

| Hash | 说明 |
|---|---|
| `0844673c` | feat(mcp): add unified OAuth status snapshot |
| `07adbacd` | feat(core): replace tools atomically by source |
| `9733cf15` | feat(mcp): activate prepared connections atomically |
| `6b838aa9` | feat(server): coordinate active MCP runtimes |
| `601251ce` | feat(mcp): commit verified OAuth credentials atomically |
| `e66248ea` | feat(client): add MCP runtime control resource |
| `751907c6` | feat(cli): complete MCP OAuth runtime workflow |
| `7096f69c` | feat(desktop): show MCP auth and runtime states |
| `4444f659` | chore(client): preserve MCP contract entry ordering |
| `7173b898` | feat(desktop): notify daemon MCP runtimes after auth changes |

## 审查目标

判断实现是否**完整、正确、安全**地满足设计规格，重点验证并发、安全和错误处理，而不是只看测试是否绿。

## 必须逐条核对的硬性约束

1. **OAuth 候选凭据隔离**：登录时 Token exchange 结果只留在本次操作内存中；只有真实 MCP `initialize`/`tools/list` 验证成功后才在 `store.runExclusive()` 内提交。验证期间活动 Runtime 必须继续读到共享 store 的旧凭据。检查 `packages/mcp/src/oauth/login.ts`（`createMemoryCredentialStore`、`revokeCandidateTokens`）与 `packages/server/src/application/mcp-oauth-application-service.ts`（`runLogin`、`commitVerifiedCredential`）。
2. **提交原子性**：settings patch 必须基于锁内重新加载的最新 settings（不能复用登录前快照），settings 保存与 credential 替换在同一 `runExclusive` 内；失败时旧凭据不被提前删除。检查 `commitVerifiedCredential`。
3. **Tool Registry 原子替换**：`replaceBySource` 必须 copy-on-write、冲突时原 Map 不变、方法内无 `await`/回调。检查 `packages/core/src/engine/tool-registry.ts`。
4. **staged connection 一致提交**：`activatePreparedConnection` 必须在同一无 `await` 临界区先切 manager 连接指针再提交工具，提交抛错时同临界区恢复旧指针并把 staged 资源交回临界区外清理；`disconnect` 必须在 `finally` 清理 maps 并上抛 `client.close()` 错误。检查 `packages/mcp/src/index.ts`。
5. **已开始 Run 不被重定向**：Run 捕获的旧 Tool Definition 只能看到旧连接/旧集合，新 Run 只能看到完整新集合；不得把进行中的调用透明切到新连接。检查 `packages/core/src/engine/query-engine.ts`（`runToolRegistry`）与 `packages/mcp/src/index.ts`（`buildToolDefinition`）。
6. **generation 防旧连接发布**：coordinator 每个 identity 单调递增 generation 并按 identity 串行 `synchronize`；handle 在 staged 建立前、发布前两次核对 generation，过期则关闭 staged 不发布；logout 触发的同步使旧 generation 在建连接失效。检查 `packages/server/src/application/mcp-runtime-connection-coordinator.ts` 与 `packages/agent-runtime/src/runtime-integrations.ts`（`stageAndActivate`、`createMcpRuntimeHandle().synchronize`）。
7. **identity 隔离**：同名不同 endpoint（不同项目 cwd）的 Runtime 不得互相影响；参与筛选必须同时匹配 name + transport + endpointFingerprint。检查 coordinator 的 `participants`。
8. **不信任通知意图**：daemon 收到 synchronize 后必须重读凭据仓库最终状态再决定重连或断开，不信任调用方携带的登录/退出意图；logout 后即使远端撤销失败也必须删除本地凭据。检查 `mcp-oauth-application-service.ts` 的 `logout` 与 runtime handle 的 `synchronize`。
9. **秘密不外泄**：Token、Authorization Header、client secret、授权码、PKCE verifier、完整 endpoint query 不得进入日志、错误响应、状态 DTO 或控制面请求。检查 `packages/mcp/src/oauth/snapshot.ts`、`packages/server/src/http/routes/mcp.ts`、`packages/core/src/types/mcp-oauth.ts`。
10. **daemon 缺席语义**：registry 不存在或连接被拒 → `unavailable`，不启动 daemon、不算登录失败；401、协议不兼容、daemon 5xx → 必须作为同步失败抛出，不得伪装成离线。检查 `apps/cli/src/mcp-runtime-coordinator.ts` 与 `apps/desktop/src/main/features/mcp/mcp-runtime-coordinator.ts` 的 `isDaemonUnreachable`。
11. **状态模型**：`authMode`（none/oauth/bearer/custom）与 `authStatus` 分离；显式静态 Authorization 优先于 OAuth；logout 后若 settings 仍保留 `oauth.scopes` 则保持 `oauth/not-logged-in`。检查 `packages/mcp/src/oauth/status.ts` 与 `snapshot.ts`。

## 请特别留意（可能的问题点）

- `replaceBySource` / `activatePreparedConnection` 临界区内是否真的没有任何 `await`、事件派发或用户回调。
- coordinator 的 `enqueue` 串行链在异常后是否仍能推进、队列是否泄漏。
- `disconnect` 改成抛错后，所有 `disconnectAll` 调用点（尤其测试 `finally`）是否仍安全。
- Desktop coordinator 直接读 `readDaemonRegistry()` 是否与 CLI/主进程使用同一 registry 路径；是否会违反“不自动启动 daemon”。
- 初始 MCP 连接改为 staged 后，连接失败隔离与工具提交冲突致命这两条语义是否都保留（`runtime-integrations.ts` 的 `Promise.all` + `McpConnectionStageError`）。
- 测试是否有被删除、放宽断言或更新无关快照来“凑绿”的痕迹；若有请指出。

## 复现验证

请运行并报告结果：

```
pnpm --filter @vykor/core test
pnpm --filter @vykor/mcp test
pnpm --filter @vykor/auth test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @rzx/ohs test
pnpm --filter @vykor/desktop test
pnpm check-types
pnpm check:client-api
node scripts/check-docs.mjs
```

已知预存在失败（与本次无关，请忽略但确认原因一致）：`apps/desktop/src/main/features/git/git-service.test.ts > reports false without throwing for a directory that is not a repository`，根因是本机 `C:\Users\ruanz\.git` 存在，`os.tmpdir()` 位于该 git 树内。

## 约束

- 只读审查，不要修改代码、不要提交、不要改写历史、不要创建 PR。
- 若发现规格与实现冲突，以设计规格为准，并明确指出文件与行为差异。

## 输出格式

1. 结论：通过 / 有条件通过 / 不通过。
2. 逐条硬性约束（上面 11 条）核对结果：满足 / 不满足 / 存疑，附文件与行为证据。
3. 问题清单，按严重级别（必须修复 / 建议修改 / 仅供参考），每条给出位置、触发条件、影响、建议修复。
4. 未覆盖或无法验证的项及原因。
5. 实际运行的命令与结果。
