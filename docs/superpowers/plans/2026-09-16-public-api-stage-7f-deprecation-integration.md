# Stage 7F：兼容层弃用标记与集成收尾实施计划

> **面向 AI 代理的工作者：** 使用 superpowers:verification-before-completion 和 superpowers:requesting-code-review。本波先完成代码/文档收尾，再统一跑全仓验证；不得因单项失败跳过剩余可运行检查。

**目标：** 在保留 Stage 7 兼容性的前提下，为所有平铺 facade 提供明确弃用信息，证明内部生产调用清零，并给 Stage 8 留下可审计的删除门槛。

**边界：** Stage 7 不删除平铺方法、不新增 subpath exports、不改变 transport/SSE getter，也不把未独立发布的 Client 伪装成已有发布周期。

---

## 任务 1：核对 7A–7E 结果

- [ ] 运行全仓 production AST 扫描，逐条处理剩余调用和成员引用。
- [ ] facade 实现及其兼容测试应由 scanner 的明确排除规则识别；不得用目录级大范围忽略。
- [ ] 确认 Client、CLI、Desktop、Frontend 四个 scope 的生产旧调用和旧成员引用均为 0。
- [ ] 确认没有用别名、解构、`any`、动态属性访问或双重 cast 绕过门禁。
- [ ] 对比 7A 公共契约快照，确认迁移未误删 runtime/type exports。

## 任务 2：为平铺 facade 添加弃用标记

- [ ] 按 7A 分类表逐个处理“兼容 facade”方法/属性。
- [ ] 每个 JSDoc `@deprecated` 写出准确替代路径，例如 `Use client.sessions.get(...) instead.`。
- [ ] 不给仍是正式公共边界的 `transport`、`sse` getter 或命名 Resource 属性错误加弃用标记。
- [ ] facade 实现继续薄转发到命名 Resource，不复制 HTTP 请求逻辑。
- [ ] 兼容测试继续验证旧入口与新入口的参数、返回值及错误一致。

## 任务 3：写迁移指南和 Stage 8 删除清单

- [ ] 新增/更新公共 API 迁移指南，包含旧入口 → 新入口完整映射、常见示例和不受影响的正式入口。
- [ ] `scripts/client-public-api-contract.json` 是唯一事实源；直接在其中维护删除门槛字段，迁移文档表由该 JSON 生成或由测试逐项校验，禁止另建手写 manifest。
- [ ] 每项至少包含 symbol、replacement、`deprecatedSince`、`deprecatedCarrierRelease`、`retentionCarrierRelease`；两份发行证据都包含 version/date/channel/release-note URL 或 commit hash。
- [ ] 尚未发生可核验发布时，字段明确写 `null`/`pending`，禁止猜版本或日期。
- [ ] 写清 Stage 8 门槛：首次弃用发行和至少一个后续仍保留 API 的发行两份证据齐全；任一 pending 都不能删除兼容层。
- [ ] 若 Client 不独立发布，固定同一个实际 carrier（默认 CLI；只有发行流程明确由 Desktop 承载时才切换），并记录 Client commit 与 carrier version 的关联规则。

## 任务 4：准备阶段状态数据（此时不标完成）

- [ ] 暂存每个 scope 的最终 AST 数；测试数必须等任务 5 实际运行后填写。
- [ ] `scripts/architecture-baseline.json` 准备收紧到 production 旧调用和旧成员引用均为 0，但阶段状态此时不得提前标为完成。
- [ ] 保留 WSL E2E/node-pty 并发资源竞争的既有说明；不要把环境问题写成产品代码通过证据。

## 任务 5：统一验证

按顺序运行并保存摘要：

- [ ] `pnpm --filter @vykor/client check-types`
- [ ] `pnpm --filter @vykor/client test`
- [ ] `pnpm --filter @vykor/frontend check-types`
- [ ] `pnpm --filter @vykor/frontend test`
- [ ] `pnpm --filter @vykor/desktop typecheck`
- [ ] `pnpm --filter @vykor/desktop test`
- [ ] `pnpm --filter @rzx/ohs check-types`
- [ ] `pnpm --filter @rzx/ohs test`
- [ ] `pnpm --filter @vykor/server check-types`
- [ ] `pnpm --filter @vykor/server test`
- [ ] `pnpm check-types`
- [ ] `pnpm check:architecture`（必须固定串联 scanner tests、runtime/type-only contract comparison 与 consumer fixture 编译）
- [ ] `node scripts/check-docs.mjs`
- [ ] `node scripts/client-legacy-calls.mjs --scope production`
- [ ] `git diff --check`

如果某命令名与仓库脚本不符，先读取 `package.json` 使用现有等价命令，并在结果中记录实际命令。测试失败时区分：本次回归、已有失败、WSL/node-pty 环境竞争；只有证据充分时才归为环境问题。

## 任务 6：子代理审查与修订

- [ ] 请求独立子代理对 Stage 7 diff 做代码审查，重点检查遗漏旧调用、错误 Resource 映射、公共导出破坏、同步生命周期回归及虚假发布证据。
- [ ] Critical/Important 结论必须修复并重跑受影响验证。
- [ ] 建议项记录采纳或不采纳理由；不扩大到 Stage 8 删除。
- [ ] 审查修订后再次运行 AST、类型检查、受影响测试、architecture、docs 和 diff check。
- [ ] 只有任务 5 验证及本任务审查闭合后，才更新 `docs/architecture-migration-status.md`：Stage 0–7 完成、Stage 8 未开始，并写入实测命令、测试数与环境阻塞；若存在未解释失败则不得标完成。

## 任务 7：拆分提交与交付

先提交弃用契约与迁移说明：

```bash
git add packages/client/src/transport packages/client/README.md scripts/client-public-api-contract.json docs/client-public-api-migration.md
git commit -m "docs(client): deprecate flat client facade"
```

统一验证、审查修订完成后，再提交基线和阶段状态收尾：

```bash
git add scripts docs packages/client apps/cli apps/desktop apps/frontend
git commit -m "chore: complete public api convergence stage"
```

- [ ] 输出 commit 列表、最终工作树状态、各验证命令结果和未执行项原因。
- [ ] 不自行合并 main、不删除分支、不 push，除非用户另行明确要求。

## 最终验收标准

- 内部生产旧调用和旧成员引用均为 0，兼容 facade 仍可用；
- 每个弃用入口都有准确替代路径；
- runtime 公共 API 快照与代表性类型消费者通过；
- 唯一契约清单使用两份真实发行证据，未发布项明确 pending；
- 全部可运行验证通过，环境阻塞被单独、如实记录；
- 子代理无未处理 Critical/Important。
