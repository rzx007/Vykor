# Agent 核心包 P6 收口与验收记录

> 状态：P0–P6 实施及整体验收全部完成。2026-10-22。

P0–P3 提交为 `946b1076`，P4 为 `63c46b00`，P5 为 `67c3aadb`。本记录覆盖 P6/T11/T12、M28/M29/M30 的最终收口；P6 代码、配套文档和验收记录随本次提交交付，未推送。工作区中的其他并行修改保留。

## 最终职责和迁移

| 位置 | 当前责任 |
| --- | --- |
| agent-contracts | 通用消息、工具数据、执行契约和错误；只有 environment 类型依赖 |
| host-config | Settings、本机路径、校验、读取和原子保存 |
| execution-node | 本地进程、输出捕获、执行观察和 LSP；创建者负责关闭 Owner |
| Core / Kernel | Core 唯一持有历史并执行模型/工具循环；Kernel 管 Run/Child、可靠事件和显式 release |
| Node | 创建或借用默认能力；根树拥有目录、TeamRegistry 和共享资源；child 关闭自己的视图 |
| Coordinator | 定义纯解析、实例团队目录和 Workflow 纯调度；删除无使用者的 Coordinator 配置包装 |
| Server / Services | Server 执行 Goal 准入/结算与管理用例；Services 保存记录和事务，存储不能反向调用辅助宿主 |
| Protocol / Client | Protocol 使用规范数据定义；Client 直接依赖 Protocol；规范 parser 仅一份实现 |
| tests/server-client | 10 个 Server/Client 联合测试，明确声明测试依赖，纳入根 test/check-types |

移除无引用依赖：permissions/environment、plugin-converters/zod、services/environment 和 sandbox。SDK 将声明引用的内部包由 optional peer 改为正式依赖；工具包公开源码需要的 diff/picomatch 类型随依赖安装。默认 bundle 实际引用 sharp、node-pty，未引用 better-sqlite3，因此只删除 SDK 的数据库驱动依赖。Native Tool 的 host-entry 保留。

Swarm 保留独立文件协作用途，不参加当前 Agent 执行；无内部消费者不足以证明可以删除其外部公开面。Office/Memory 辅助子域保留现有功能，存储记录域和 session-runtime 均受反向依赖限制。

## 边界与 SDK 证据

架构策略阶段为 P6，阶段例外为 0。AST 检查静态、类型、动态导入、再导出、TS alias 与跨包相对路径；Client 的直接依赖和 Protocol 传递的规范声明分别检查，不允许通过 barrel 绕过直接依赖规则。

构建保存 default/kernel 两份 metafile；Kernel 递归检查相对声明、包 exports、import type、import-equals 和三斜线引用。独立消费者在仓库外安装 tarball，再严格编译 Node/Kernel/Workflow 类型，运行 root/child、事件、关闭、跨 bundle 错误身份、Native Tool 和 PTY/Job。

主要回归：Core 438、Runtime 824、Services 576、Server 1748、CLI 243、TUI 151、Desktop 2718 项通过；既有平台跳过保持原样。运行环境为 Windows、Node 24.18.1、pnpm 10.30.2。

完整 A01–A07/B01–B11 与具体测试、命令的对应关系见[契约与测试索引](../../contract-test-index.md#agent-包收敛验收p0p6)。

## 集中验证

| 命令 | 结果 |
| --- | --- |
| `pnpm check-types` | exit 0；67/67 workspace 任务及联合类型检查；Protocol/Client/SDK 子入口变更后 3 包补验 exit 0 |
| `pnpm check:architecture` | exit 0；46 项架构反例，阶段例外 0；flat calls 基线由 109 收紧至 104，719 条历史引用逐条检查通过 |
| `pnpm test` | exit 0；68/68 workspace 任务；脚本、134 项插件测试、本地执行集成、10 文件 124 项联合测试均通过 |
| `pnpm --filter @vykor/agent-runtime test:pack` | exit 0；严格声明消费、错误身份、Native Tool、PTY、root/child/事件/幂等关闭全部通过 |
| `pnpm test:client-browser` | exit 0 |
| `pnpm check-docs` | exit 0；467 个 Markdown 文件及链接/源码路径/契约映射 |

架构图通过 archify 生成：9/9 检查、0 错误、0 警告，23 条源码证据固定到 P5 提交；未进行浏览器视觉检查。未执行发布或推送。

## 失败处置和回退

独立类型消费最先发现 tools 源码分发缺少 diff/picomatch 声明依赖，已将既有类型包移入运行依赖。跨 bundle `instanceof` 失败已复现，为正式导出的执行错误补上共享品牌，普通同名 Error 不被接受。

首轮 PTY 夹具把结果引用头与 JSON 拼接，导致解析失败；按内容块读取 JSON，并为临时消费者设置独立配置/数据目录，避免读取本机插件。Windows node-pty 的控制台辅助进程可能输出 AttachConsole 诊断；是否通过以实际终端打开、取消、等待及退出码为准，不跳过断言。

独立审查提出两项验收缺口：跳过声明检查并借用仓库 typeRoots；声明遍历漏 import-equals/三斜线引用。均已修复并复查关闭，剩余 Critical/Important/Minor 均为 0。

完整测试发现 CLI/TUI 假 Agent 仍返回旧对象、桌面联合测试仍导入旧 Kernel 路径，已迁移到显式 HostedAgent 和 engine/preparation。租约断言由原对象引用改为标识、所有权和幂等释放行为；定向 3/19/25 项通过。SDK stdin 加入延迟输出回归，等待实际 echo，不再依赖固定 250ms。

统一 Vitest 为每个测试文件创建临时配置/数据目录，并限制 2 个 worker；桌面采用相同设置。Bun 子进程显式隔离配置。Turbo 把测试配置加入缓存输入，workspace 测试收集各包结果后统一返回失败。没有提高超时或修改产品权限、预算行为。

本阶段未改 SQLite/文件格式和协议版本；回退应把各接口使用者和依赖/测试迁移一起回退，不重建用户数据。

## 最终复查后的两项 P2 修复（2026-10-22）

复查对象为 `bd63a584 → c398e3d8`。本次修复及配套记录随本次提交交付，不包含其他并行修改，未推送。

1. **自定义 WorkflowHost 取消。** 默认取消回调调用 `interruptChildAgent` 后，child 的运行、资源和目录清理已经完成；删除其后再次按 ID 查询结果的代码，保留关闭异常向上传播。新增真实 ChildManager、Kernel 与可控资源释放的回归，覆盖 JobCancel、父 Run 取消、owner 关闭和 Host 关闭。每种入口均确认资源释放前取消未完成、最终保存取消终态、child 移出目录、资源只释放一次，以及后续幂等关闭成功。四项回归在旧实现上全部失败，错误包括 child 已移除和 Workflow 关闭失败，修复后全部通过。
2. **普通 CI 持续检查。** 在类型检查后、完整测试前加入架构和文档检查；不设置跳过条件或失败后继续。YAML 解析与步骤配置检查通过；本次本地验证执行这两个命令，不重复执行完整测试。

工作区首轮架构聚合检查中，依赖扫描、架构反例、Client API 和数据基线检查均通过；最后的历史引用检查因并行修改的行号变化失败。随后使用 `c398e3d8` 的源码快照，仅覆盖本次所属文件，复用已安装工具链，排除并行业务代码。快照另外发现 P6 基线中的五条历史批准行号与已提交源码不一致，已逐条核对并校正；原文本、批准理由和 719 条总数不变，未新增或放宽批准。

| 本次定向验证 | 结果 |
| --- | --- |
| Runtime：自定义取消、WorkflowHost、默认 Node 关闭、文件 Workflow 集成 | exit 0；4 文件、29 项通过，包含新增的 4 项回归 |
| Server：SQLite WorkflowHost | exit 0；1 文件、7 项通过 |
| Runtime 类型检查及新增回归文件的单独类型检查 | exit 0；新增回归通过临时 TypeScript 配置纳入编译 |
| 源码快照 `pnpm check:architecture` | exit 0；55 项架构/兼容反例、4 项 Client API 测试及数据基线通过；阶段例外 0、平铺调用 104、历史引用 719 条 |
| 源码快照 `pnpm check-docs` | exit 0；467 个 Markdown 文件的链接、源码路径与契约映射通过 |
| 普通 CI YAML 与检查步骤 | 解析通过；架构和文档检查均无条件执行、失败阻断 |

修复阶段未重新运行 `pnpm test`、全仓类型检查或 SDK 打包；提交时沿用既有类型检查钩子。本次没有变更公开签名、依赖或发布产物。新增回归的契约对应已加入[测试索引](../../contract-test-index.md#agent-包收敛验收p0p6)。
