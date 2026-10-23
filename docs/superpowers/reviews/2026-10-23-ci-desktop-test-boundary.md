# Desktop 跨包测试导致 CI 构建失败的修复验收

> 状态：当前 CI 修复记录；只覆盖跨包测试归属、CI 接入及相关文档。

## 失败原因

[4517a512 的 CI](https://github.com/rzx007/Vykor/actions/runs/39896653950) 在 Desktop Build 步骤失败：[订阅合并测试](../../../apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts) 直接导入 Core，被 Desktop 依赖边界检查拒绝。后续 main 提交 9f29e24c 的 [CI](https://github.com/rzx007/Vykor/actions/runs/39897185762) 同样失败于此处；后续类型、架构、文档和测试步骤尚未运行。

这个文件混入了一个从真实模型流解析、Agent 执行、SQLite 投影到桌面展示的完整流程用例。它此前还使用相对路径导入其他包；Core 路径调整为公开入口后，现有门禁暴露了测试归属问题。

## 修复范围

- 把完整 Write 流程用例迁入 [Desktop 跨包集成测试](../../../tests/desktop-integration/README.md)；原文件保留 18 个客户端订阅行为用例，不再导入 Core、Runtime、API、工具或 Server 实现。
- 新组复用 Desktop 的转换插件、别名和隔离设置，React 使用 Desktop 已有依赖；不增加依赖，也不修改锁文件。
- 根测试命令新增 test:desktop-integration，现有普通 CI 的 pnpm test 自动覆盖该组；同步更新 [契约测试索引](../../contract-test-index.md)。
- Desktop 依赖边界允许表保持原样。使用现有门禁复现修复前失败，并验证迁移后通过；没有通过放宽约束消除报错。

## 集中验证

| 范围 | 结果 |
| --- | --- |
| Desktop 订阅合并回归 | 18 项通过 |
| pnpm test:desktop-integration | 完整 Write 生成、未落盘展示、单次交接与落盘用例通过 |
| 迁移断言保留 | TypeScript 语法树比对：原 19 个用例的名称和正文全部一致 |
| Desktop 依赖门禁与 CI 接入 | 门禁通过；根测试命令和 CI 调用链核对通过 |
| Desktop 类型检查 | 构建中的 Node、Web、MCP App SDK 三项均通过 |
| pnpm --filter @vykor/desktop run build | 完整构建通过，覆盖边界检查、三项类型检查、文档预览、主进程、preload 和 renderer 打包 |
| 架构扫描 | 通过；104 处既有 SessionStore 调用，阶段例外 0 |
| pnpm check:retired-ui | 通过；729 条精确批准、90 个删除路径，零错误 |
| pnpm check-docs | 481 个 Markdown 文件通过 |

未运行完整测试套件。构建输出仅产生已有的依赖外置、分块和路由测试文件提示，不影响退出结果；没有为这些提示扩大修复范围。推送后不等待新一轮 CI，由用户反馈后续结果。
