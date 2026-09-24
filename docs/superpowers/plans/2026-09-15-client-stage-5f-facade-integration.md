# Client 阶段 5F：兼容门面、调用方与统一验收实现计划

> **面向 AI 代理的工作者：** 本计划执行最终整合、一次性测试和集中修复。不要提前删除公共兼容方法。

**目标：** 将 VykorClient 收缩为 Transport/Resource 组合根和兼容转发，迁移窄内部调用方，检查 Server Route 边界并完成阶段 5。

**架构：** 一个 Client 实例只构造一组 Transport/Resource。旧平铺 API 全部保留；Server Route 只修明确存在的业务越界。

**技术栈：** TypeScript、Vitest、pnpm、architecture checker。

---

## 批量生产收尾

- [ ] VykorClient 仅保存 transport、protocol 和 Resource readonly 属性。
- [ ] 检查所有旧 public 方法存在、签名兼容、只转发。
- [ ] 删除 http-client.ts 中 endpoint path、业务 decoder、SSE parser 和重复 helper。
- [ ] 顶层 index 同时导出旧 API 和新 Resource，不改变 package exports 路径。
- [ ] commands/sync 使用窄 capability。
- [ ] Desktop/Frontend/CLI 只迁能直接降低完整 Client 依赖的内部位置，不改状态/IPC/UI。
- [ ] 审计 server/http/routes：只修明确的 queue/status/permission 等业务规则越界，调用阶段4服务。
- [ ] 不为纯适配 Route 做目录搬家。
- [ ] 新增架构规则：Resource 不导入 VykorClient/Server；Transport 不导入 Resource；http-client endpoint 字符串只减不增；新内部模块不接完整 Client。
- [ ] 更新 architecture baseline，只能下降。
- [ ] 更新 architecture-migration-status：阶段0–5完成，阶段6未开始。
- [ ] 记录 http-client.ts 前后行数、Resource 数、flat calls、未迁外部兼容调用。

## 一次性测试与集中修复

按顺序运行一次：

- pnpm --filter @vykor/client test
- pnpm --filter @vykor/server test -- src/http
- pnpm --filter @rzx/ohs test
- pnpm --filter @vykor/desktop test
- pnpm check-types
- node --test scripts/architecture-boundaries.test.mjs
- pnpm check:architecture
- node scripts/check-docs.mjs
- git diff --check

- [ ] 收集所有失败并按 Transport、Resource、Facade、Consumer、环境分类。
- [ ] 一次性修复所有真实回归。
- [ ] 只对失败集合做定向重跑。
- [ ] 最终再跑一次上述完整验证。
- [ ] 已知 WSL/node-pty 并发问题记录测试名和单跑结果，不改业务规避。
- [ ] 执行一次统一代码审查，集中列出全部 Critical/Important。
- [ ] 一次性修复 Critical/Important 后做最终复审。
- [ ] 提交：chore: complete client transport resource reorganization

## 完成检查

- Transport 无业务 endpoint。
- ProtocolClient 唯一协商。
- Resource 可独立构造测试。
- VykorClient 只组合/转发。
- 外部协议和公开方法兼容。
- httpClientFlatCalls 降低且未调高 baseline。
- 阶段 6 未提前实施。

## 交付报告

列全部 commit、方法迁移表、文件、测试数量、类型/架构结果、http-client 行数、flat calls、审查问题、已知环境失败和未删除兼容入口。
