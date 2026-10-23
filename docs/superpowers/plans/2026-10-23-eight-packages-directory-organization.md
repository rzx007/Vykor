# 八个包的目录、测试与说明整理计划

**目标：** 按现有仓库规范整理 protocol、client、tools、host-config、plugins、plugin-sources、plugin-converters、plugin-contracts。

**方案：** 保留包边界和公开导出名称，只移动文件并同步引用。测试与被测模块放在同一分类的 `__test__/`；跨分类测试留在共同目录的 `__test__/`。保留测试断言、夹具内容、配置文件格式和运行行为。

**依据：** [AGENTS.md](../../../AGENTS.md) 中的“目录、测试与说明”，以及本次用户要求一起处理八个候选包。

## 目录方案

| 包 | 分类与入口 |
| --- | --- |
| protocol | `src/index.ts` 保留入口；按 `session`、`permissions`、`attachments`、`channels`、`extensions`、`runtime`、`knowledge`、`requests`、`serialization` 分类 |
| client | 保留 `commands`、`protocol`、`state`、`transport`、`types`；增加 `configuration`；`resources` 下按 `session`、`plugins`、`configuration`、`workspace`、`runtime` 分类 |
| tools | 保留现有工具分类；`file` 内增加 `editing`、`search`、`access`；通用取消处理归入 `shared` |
| host-config | 保留 `src/index.ts`；按 `settings`、`permissions`、`extensions`、`storage` 分类 |
| plugins | 保留根入口及 SDK 入口；新增 `loading`、`shared`，保留 `activation`、`components`、`installation`、`manifest`；测试帮助代码归入 `src/__test__/helpers` |
| plugin-sources | 保留根入口；按 `sources`、`marketplace` 分类，示例打包测试放 `scripts/__test__/` |
| plugin-converters | 保留 `core`、`claude-code`、`codex` 分类；统一各层测试目录，补齐包导航和分类说明 |
| plugin-contracts | 保留所有公开子路径名称，内部按 `manifest`、`marketplace`、`runtime` 分类 |

## 执行步骤

- [x] 记录起始提交与文件内容，列出迁移映射；检查目标路径冲突。
- [x] 按目录方案移动实现和测试，同步仓库内导入、源码路径、公开导出目标、文档及旧引用清单。
- [x] 修正移动后的相对夹具地址；`tools` 中两个同名 Bash 测试保留各自断言，将 Shell 方言诊断测试命名为 `shell-dialect.test.ts`。
- [x] SDK 编译测试移到 `packages/plugins/__test__/sdk.type-test.ts` 并同步专用 TypeScript 配置。
- [x] 每个分类补齐 README：用途、主要文件、入口、执行步骤、状态归属、新代码放置建议；包根提供导航。
- [x] 核对所有模块除路径引用外内容不变，公开导出名称不变，夹具内容不变，测试数量不减少，README 链接有效。
- [x] 执行八个包的测试与 `pnpm check-types`，覆盖 SDK 示例编译及仓库内消费者引用。
- [x] 执行 `pnpm check:architecture`、`pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`，修复本次迁移产生的问题。
- [x] 汇报实际改动与检查结果；本次先整理和验证，提交、推送按用户后续指示执行。

## 验证命令

```powershell
pnpm --filter @vykor/protocol --filter @vykor/client --filter @vykor/tools --filter @vykor/host-config --filter @vykor/plugins --filter @vykor/plugin-sources --filter @vykor/plugin-converters --filter @vykor/plugin-contracts --workspace-concurrency=2 -r test
pnpm check-types
pnpm check:architecture
pnpm check:retired-ui
pnpm check-docs
git diff --check
```

## 结果

- 起始提交：`90a0ef0a`。迁移 100 个实现文件、90 个测试文件和 1 个测试夹具；源码根目录保留公开入口，测试统一放入同层 `__test__/`。
- 新增或补充 82 份 README，覆盖 67 个直接包含实现代码的分类目录；478 个本地链接核对有效。
- 核对 358 个包内代码文件及 9 个外部引用文件；实现和断言只变更路径引用，436 条相对引用仍指向迁移后的同一目标，24 个既有夹具内容未变。
- 公开导出名称、依赖及包命令保持原样。`plugin-sources` 增加 Vitest 配置，同时发现 `src` 和 `scripts` 中的测试，避免打包测试迁移后漏跑。
- 八个包共 126 个 Vitest 测试文件通过，1333 个用例通过、1 个跳过；另有 2 个类型测试文件由 TypeScript 检查覆盖。全仓 `pnpm check-types` 的 72 项任务及 Server Client 类型检查通过。
- Agent Runtime 插件应用、Agent 文件流程、Desktop 文件摘要共 20 个消费方回归用例通过；清理检查器的 4 个单元测试通过。
- 架构检查通过：66 个检查器测试及客户端公开 API 校验通过，原有平面调用计数为 104、规则例外为 0。旧引用与文档检查通过；包含新增文件的完整差异没有空白错误。
- 旧引用清单保留 729 条既有记录的理由与逐行约束，新增 3 条目录文档的精确记录；90 个已移除实现路径清单保持原样。
- 首次并行测试中，文件写入事实用例有一次断言失败；同一用例单独运行和 Tools 整包复跑均通过，未稳定复现，也未修改该用例断言或文件写入行为。
- 工作区内其他并行修改保留。本次整理尚未提交或推送。
