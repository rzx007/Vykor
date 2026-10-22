# Protocol 分层 P7 基线与验收记录

> 状态：P7 历史基线；阶段代码与验收完成，随本次 P7–P13 整体提交。2026-10-22；业务基线为 `01035993`。本阶段没有迁移业务代码、创建契约包或改变运行依赖。

方案见 [Protocol 分层收敛方案](../specs/2026-10-22-protocol-layering-design.md)，后续安排见 [P7–P13 计划](../plans/2026-10-22-protocol-layering.md)。固定样本和原始导入清单保存在[基线 JSON](./2026-10-22-protocol-layering-baseline.json)。该文件只记录迁移前事实，后续不能为使检查通过而重新生成预期结果。

迁移后的当前结果见[最终验收记录](./2026-10-22-protocol-layering-closeout.md)；以下原始数量及 JSON 预期保持不变。

## P7 迁移前依赖

| 包 | Protocol manifest 依赖 | 直接引用的源文件（含测试） | AST 导入组数 |
| --- | --- | --- | --- |
| agent-runtime | 1 | 14 | 20 |
| channels | 1 | 3 | 3 |
| host-config | 1 | 1 | 1 |
| jobs | 1 | 1 | 7 |
| mcp | 1 | 2 | 2 |
| plugins | 1 | 7 | 9 |
| sandbox | 1 | 1 | 1 |
| services | 1 | 41 | 56 |
| terminal | 1 | 2 | 16 |
| Server application | Server 清单由 HTTP 共用，不整体禁止 | 99 | 158 |

九个底层包仍声明运行依赖，直接引用合计 72 个文件、115 个导入组；加上 Server application 后合计 171 个文件、273 个导入组。一个声明中的值和类型可以分为两组；不能把导入组数当作源码行数。原始清单包含 import type 表达式、测试、再导出和相对路径；隐藏声明来源由完整的架构扫描另外登记。

## 新门禁与过渡例外

目标规则已移除九个底层包对 Protocol 的允许关系；Server application 使用单独的包内规则，HTTP 和 Client 保留通信职责。新契约包的职责和纯数据入口已登记到策略，实际代码包留待 P8–P10 创建。

扫描继续使用[既有 AST 工具](../../../scripts/architecture-policy.mjs)，补上函数/变量的明确类型签名、类型包装和循环引用追踪。追踪到 Protocol 的规范声明后即可确认越界，不为凑数量继续展开其全部字段。函数体中的临时类型不视为对外签名；未显式声明的推断类型仍需要后续声明构建与消费验证，P7 不声称替代 P12 的 SDK 检查。

纯数据入口同时限制导入目标、Node/第三方实现、生产 manifest 依赖，以及本地定义中出现的 AbortSignal、Promise、Repository 等运行对象；包括 extends 和 typeof 包装。实现入口、异步等待和资源关闭接口不能藏进数据文件。

| 迁移 / 截止阶段 | 精确例外数 | 负责人 |
| --- | --- | --- |
| M32 / P8 | 32 | 配置与权限类型 |
| M33 / P8 | 56 | Job / Terminal 数据 |
| M34 / P9 | 79 | 插件与 MCP 数据 |
| M35 / P10 | 982 | Services 领域记录与命令 |
| M37 / P10 | 13 | 通道应用桥接 |
| M38 / P11 | 3,011 | Node 与 Server 应用接口 |
| 合计 | 4,173 | P0–P6 旧例外为 0 |

例外数包括 manifest、直接导入、再导出和隐藏的声明来源，同一源文件可能到达多个声明文件，因此大于直接导入组数。每项绑定来源文件、目标路径、符号集合、值/类型类别、迁移编号和截止阶段；不存在目录级放行。M31、M36、M39、M40 是后续工作主题，当前没有独立例外；JSON 和存储命令的现存关系暂由消费包负责人登记，不凭空创建空例外。

新增来源、符号、值导入或隐藏包装不能借用现有例外；过期、残留或迁移编号不匹配都会失败。后续迁移改变组合导入时，可以删掉已迁移符号并缩小剩余例外，不能借刷新基线增加符号。

依赖登记本身不是新增的历史执行代码。历史引用检查只对这两个精确数据字段（架构策略的 stageExceptions、基线 JSON 的 dependencyInventory）按清单处理，实际源码仍逐行检查，其他配置字段也照常检查。原有 719 条历史批准的文本、理由和数量不变，仅随工具行位移校正 11 个行号。新回归验证清单不会批准新源码引用。

## 固定兼容样本

基线保存 22 个类型声明的字段/可选性/联合类型，覆盖 Session、Run、Goal、附件、插件应用、审批、Job、Terminal 和 Schedule；另存 3 个现有类型消费样本的路径与 LF 文本摘要。

JSON 固定样本包含数字键、原型键、中文 UTF-8 字节、数组和空对象，保存确定字符串、字节数与 SHA-256。新增[行为回归](../../../packages/protocol/src/layering-baseline.test.ts)验证精确字节上限、非有限数/循环值、空原型对象、canonical 与插件复制的不同深度、7 种存储权限值、6 种执行模式组合，以及错误 code/field/reason 包装。

其中 canonical 数组可嵌套 20 层，插件复制可嵌套 32 层；对象自身也占层级。MCP 结果继续保留原有 `depth > 32` 和 100,000 节点规则，本阶段没有改它的算法。协议版本固定为 5，SQLite 和文件格式未改动。

## 集中验证

实施前已确认新增边界反例在旧规则上失败；新增检查后统一验证通过。

| 命令 | 结果 |
| --- | --- |
| `pnpm check:architecture` | exit 0；51 项架构反例、9 项兼容检查、4 项 Client API 测试及 Client 类型消费通过；workspace 无依赖环；clean-slate 检查通过；最后补强声明追踪后的结果见下一行 |
| `node --test scripts/architecture-boundaries.test.mjs`、`node scripts/architecture-boundaries.mjs` | 补验均 exit 0；51 项通过；最终 4,173 条精确例外，旧例外 0，flat calls 104 |
| 同一聚合入口中的历史检查 | exit 0；工具回归 1 项、719 条批准、90 个移除路径检查通过；批准文本/理由/数量与 HEAD 逐项一致，11 个行号校正 |
| `pnpm --filter @vykor/protocol exec vitest run src/layering-baseline.test.ts src/json.test.ts src/approval-mode.test.ts src/requests.test.ts` | exit 0；4 文件、38 项通过，其中新增基线回归 18 项 |
| `pnpm check-docs` | exit 0；470 个 Markdown 文件及链接/章节/状态/契约映射通过 |
| `git diff --check` | exit 0；新增文件另做行末空白检查 |

架构与文档入口已由普通 CI 调用；本阶段复用原入口，不新增另一套扫描或重复 CI 作业。Windows、Node 24.18.1、pnpm 10.30.2；未在本机重复 Linux CI 环境。

最后复查单独补充整模块 namespace/dynamic 加载的反例，先复现漏查，再修正追踪本地导出签名。最终例外从 4,049 增至 4,173，原因是补齐既有声明来源，业务依赖没有新增。只补验受影响的扫描和架构反例，未重复 Client/Protocol 已通过且未受影响的测试。

本阶段不运行全量测试、完整 SDK 打包或浏览器构建；它们留给实际改变契约与消费方式的阶段。回退以 P7 的策略、扫描器、回归和记录整体为单位，不恢复或扩大 P0–P6 的旧例外。
