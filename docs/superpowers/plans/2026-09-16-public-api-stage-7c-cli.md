# Stage 7C：CLI 消费者迁移实施计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans。先完成本波生产代码，再做 CLI 定向验证；全仓回归集中在 7F。

**目标：** CLI 业务代码通过命名 Resource/Protocol 调用 Client，不再依赖平铺兼容方法。

**边界：** 不改变命令名、参数、输出格式、退出码、重试策略和 daemon 启动流程。`withDaemonRetry` 可继续持有完整 Client 以刷新连接，但业务回调进入后必须立即选择命名能力。

---

## 涉及文件

- `apps/cli/src/print-session.ts`
- `apps/cli/src/commands/channels.ts`
- `apps/cli/src/commands/plugin.ts`
- 7A AST 报告发现的其他 `apps/cli/src` 生产文件
- 对应 `apps/cli/src/**/__tests__` 或 `*.test.ts`
- `scripts/architecture-baseline.json`
- `docs/architecture-migration-status.md`

## 任务 1：建立本波清单

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/cli/src`。
- [ ] 对每条结果记录文件、旧入口、替代入口及所属命令。
- [ ] 单独检查别名、解构和 `(await client())` 写法；不得只靠文本搜索。
- [ ] 至少人工检查 `print-session.ts`、`channels.ts`、`plugin.ts`，避免旧正则曾漏掉的调用再次漏检。

## 任务 2：迁移生产调用

- [ ] 会话读取改用 `client.sessions.*`。
- [ ] 频道操作改用 `client.channels.*`。
- [ ] 插件操作改用 `client.plugins.*`。
- [ ] 健康检查和能力协商改用 `client.protocol.health()`、`client.protocol.capabilities()`，不得放入 `system`。
- [ ] 设置与系统信息使用 `client.system.*`；附件、权限、任务等按 7A 契约表选择同名 Resource。
- [ ] 若业务函数当前接收 `VykorClient`，把参数缩成实际使用的 `Pick<Resource, ...>` 组合；连接创建/刷新边界可以保留完整 Client。
- [ ] 保留原参数对象、错误包装、输出序列化、重试次数与时序。

## 任务 3：迁移测试替身

- [ ] 把平铺 mock 改为 `sessions/channels/plugins/protocol/system` 等嵌套对象。
- [ ] 不用 `as unknown as VykorClient` 掩盖类型问题。
- [ ] 保留对 stdout/stderr、退出码、调用参数和错误分支的原有断言。
- [ ] 为 `plugin.ts` 的异步 Client 工厂/别名路径保留一个回归用例，证明迁移未绕过 AST 门禁。

## 任务 4：静态清单核对

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/cli/src`，预期调用和成员引用均为 0。
- [ ] 本波不运行 `@rzx/ohs` 类型检查、测试或根门禁；统一留到 7F，提交说明注明“尚未统一验证”。
- [ ] baseline 只能收紧，不能新增 allowlist 绕过。

## 任务 5：提交

```bash
git add apps/cli/src scripts/architecture-baseline.json docs/architecture-migration-status.md
git commit -m "refactor(cli): use named client resources"
```

## 验收标准

- CLI 生产旧调用和旧成员引用为 0；
- 用户可见行为、退出码和 daemon 重试保持不变；
- 测试替身体现 Resource 边界；
- 完整类型、测试及架构门禁结果由 7F 给出。
