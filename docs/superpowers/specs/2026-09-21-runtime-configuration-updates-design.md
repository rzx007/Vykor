# 会话运行中修改配置

> 状态：当前设计；需求范围已在会话中确认，尚未实现。

## 已确认的体验

用户可以在会话持续运行时修改模型、推理强度等配置，保留会话、历史、工具结果和任务进度。修改会话配置、修改配置文件、调用 agent-runtime API，最终遵循一致的应用规则。

- 界面不增加“待生效”“已生效”等状态提示、徽标或成功通知。
- 选择器显示用户最新选择；修改失败走现有错误反馈，并恢复服务端认可的选择。
- 当前模型请求及其发出的工具调用完成后，下一次模型请求使用新配置。
- 不主动中断正在输出的请求，不重放已经执行的工具。
- Native/WSL 等执行环境不在本次范围。

“下一次请求”包括同一用户任务中的后续请求，不要求等待整个任务结束。若当前请求直接给出最终回答，新值用于后续任务。

## 当前代码与限制

| 位置 | 当前行为 | 需要改变的地方 |
| --- | --- | --- |
| `packages/server/src/application/session/session-command-service.ts` | 所有 runtime metadata 变化共用独占屏障；有活跃任务或子 Agent 时拒绝；成功后关闭 Agent | 按实际变化字段判断，模型请求配置不再要求会话空闲 |
| `packages/agent-runtime/src/agent.ts` | `setModel` 只允许 idle | 新增统一的运行配置修改入口；旧同步入口保留原契约 |
| `packages/core/src/engine/query-engine.ts` | model、client、reasoningEffort 分开保存；prompt 在循环外构建 | 每次请求使用一份完整配置，并在请求之间重新取得配置 |
| `packages/agent-runtime/src/default-runtime.ts` | prompt 闭包读取创建时的 configuration/settings | prompt 根据本次请求配置生成 |
| `packages/server/src/daemon/daemon-agent.ts` | 创建 Agent 时把 effort 转为 reasoningEffort | 模型变化后重新校验强度并生成请求参数 |
| `packages/server/src/application/agent/agent-pool.ts` | 长期复用 Agent；软更新等整个 run 结束再重建 | 请求参数更新保留同一个 Agent |
| `packages/server/src/application/default-services/settings-service.ts` | provider/MCP/plugins 等走 restart，effort 等走 invalidate | 后续文件同步阶段按字段和作用范围处理 |
| `packages/agent-runtime/src/child-agent.ts` | 新子 Agent 从创建父 Agent 时的 configuration 派生 | 新子 Agent 从父 Agent 当前已应用配置派生 |

可复用的基础：QueryEngine 已有切换 model/client/maxTurns 的方法；会话 metadata、事件推送和错误展示已存在；MCP 已有连接代次、同步和运行期间保留旧连接的机制。

注意：`effort` 参与提示词生成，`reasoningEffort` 才是请求字段，不能只更新其一。`QueryEngineOptions.maxTokens` 当前还用于历史压缩阈值，不能在本需求中把它直接当作输出 token 上限。

## 分阶段边界

### 第一阶段：会话模型与推理强度

交付一个完整闭环：桌面/TUI/CLI 现有会话修改入口、server、agent-runtime、模型请求、历史记录与错误反馈。

包括 model、provider、baseUrl、apiFormat、effort 的一致切换。同 provider 的模型切换先完成；跨 provider 的请求适配和验证在本阶段后续任务完成后才开放。不能把新的 model ID 发给旧 provider。

第一阶段保持现有全局默认与会话覆盖关系；不宣称已支持配置文件热更新、权限热更新、插件热插拔。会话角色、工具列表、permissionMode 等仍按现有规则处理。相同字段值不构成变化；冷热字段混合修改整体校验，不能只应用一半。

### 第二阶段：配置文件与默认值同步

接入全局/项目 settings 文件变化与设置页面修改。支持模型、provider 相关连接参数、effort、systemPrompt、workStyle、fastMode、maxTurns；每个字段都要完成消费者接线后才列为动态配置。

此阶段明确配置来源、会话跟随默认与恢复默认。它依赖第一阶段的请求边界和公共校验逻辑，但独立编写实施计划。

### 第三阶段：资源热插拔

MCP、插件、工具集合、权限变更分别落实资源准备、调用保护、能力刷新和释放规则。使用现有连接协调器，不重新实现一套 MCP 连接池。此阶段独立设计和实施，不作为第一阶段的隐含完成项。

执行环境切换始终排除在以上阶段之外。

## 第一阶段运行流程

1. 会话修改入口接收 patch，按 session 串行合并最新配置，校验组合是否合法。不同会话互不阻塞。
2. 更新会话 metadata 中的目标值和内部 revision，在事务成功后发布现有会话更新事件。revision 是配置版本号，仅供程序判断先后。
3. 已有 Agent 保持运行。模型请求循环在当前响应和工具结果完成后读取最新版本。
4. agent-runtime 解析 provider、强度和新客户端，生成一份完整请求配置。准备期间不改当前请求使用的对象。
5. 在使用新模型执行历史压缩和发送请求之前，固定本次配置。压缩、主请求、提示词、模型能力检查使用同一份配置。
6. 通过既有有序 Agent 事件通道记录这次请求实际使用的配置。界面只更新选择器与正常消息，不展示配置状态。

存在附加异步工作（如自动压缩）时，当前边界已经选定的版本保持不变；期间接收的新修改进入下一个请求边界。避免压缩到一半更换模型、重复压缩或持续修改导致请求饿死。

如果运行处于 idle，下一次提交读取最新配置。处于手动 compact/remember 等维护操作时，可以保存目标配置，但不改动维护操作已经捕获的配置；后续模型请求再应用。关闭、归档、删除仍拥有原来的生命周期保护，不能因放开模型修改而绕过。

## 配置状态与接口

只保留必要的两类状态：

- **目标配置**：用户选择的值。daemon 保存到 session.metadata；独立 SDK Agent 保存在内存。
- **请求配置**：当前请求实际使用的完整值与客户端。保存在运行实例；请求元数据记录脱敏摘要，用于恢复和定位问题。

第一阶段不新增数据库表。会话目标值继续使用 `metadata.runtime`，版本使用相邻的 `metadata.runtimeRevision`，避免往有严格字段校验的 runtime 对象里塞版本字段。旧会话没有 revision 时从 0 起步；读取旧会话不隐式修改数据。

计划新增的请求选择类型：

```ts
type AgentRequestConfiguration = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
  effort?: string;
};

type AgentRequestConfigurationSnapshot = {
  revision: number;
  configuration: Readonly<AgentRequestConfiguration>;
};

type AgentRequestConfigurationPatch = Partial<AgentRequestConfiguration>;
```

使用小型配置读取契约连接两种来源：独立 SDK Agent 的内存存储与 daemon 会话记录。内存存储可以读写；daemon Agent 只读取目标配置，会话写入、校验、版本更新由 server 的会话命令负责。agent-runtime 不持有会话历史或服务端锁。

```ts
interface AgentRequestConfigurationReader {
  read(): Promise<AgentRequestConfigurationSnapshot>;
}

interface AgentRequestConfigurationStore extends AgentRequestConfigurationReader {
  update(patch: AgentRequestConfigurationPatch): Promise<AgentRequestConfigurationSnapshot>;
  restoreIfCurrent(
    failedRevision: number,
    previous: Readonly<AgentRequestConfiguration>,
  ): Promise<AgentRequestConfigurationSnapshot | undefined>;
}
```

独立 SDK Agent 的 `updateConfiguration(patch)` 调用内存存储并返回被接受的快照，不等待当前长请求完成。daemon Agent 的 `setModel()` 和 `updateConfiguration()` 明确拒绝直接修改，调用方通过会话命令写入 server 管理的目标配置；默认内存实现让独立 SDK 调用者无需创建存储对象。

`restoreIfCurrent` 是运行时失败恢复入口：仅当当前版本仍等于 failedRevision 时写入 previous 并递增版本；否则返回 undefined。恢复使用保存前相同的校验，不绕过已撤销的凭证或生命周期限制。

不把 core 依赖反向接到 server/protocol/api。core 只接收已准备好的完整请求配置；provider 解析、凭证和模型目录留在 agent-runtime/宿主层。

默认 SDK 内存存储的旧 `setModel` 保留同步、空闲期调用契约，内部同步目标模型与请求配置缓存。宿主管理目标配置的 Agent 使用会话更新入口；daemon 的 run executor 不再每轮通过 `setModel` 回写可能过期的 session 快照。

## 生效与并发规则

- 同一 session 的配置写入按接收顺序串行执行，合并时读取最新值，避免 model 与 effort 的并发 patch 丢失。
- A → B → C 在下次请求前全部保存成功时，下一次请求直接用 C。B 不产生“已使用”记录。
- SDK store 返回快照的副本，调用者不能通过原对象引用改掉已捕获的请求参数。
- 客户端复用键包含 provider、地址、协议以及实际凭证/请求头来源；仅变 effort 不重建连接。密钥不进入日志、事件或会话 metadata。
- 权限、角色或工具变更与模型变更混在一起时，保留原来的保护并整体成功或失败。
- 更改父会话模型不会修改正在运行的子 Agent。新子 Agent 继承父 Agent 已应用的模型与强度；子任务自己的显式选择优先。
- 已经建立的子会话直接修改目标配置，通过对应会话的配置存储读取，不另建一个 pool Agent 抢占其运行所有权。
- 取消、关闭、归档、删除与配置更新竞争时，不能恢复已关闭 Agent；异步准备结束必须复查生命周期/取消信号。

## 模型能力、历史与失败

### 模型与强度

显式设置模型不支持的 effort，修改直接失败，原配置保留。模型切换携带旧模型遗留的 effort 时，若新模型不支持它，则在同一次更新中清除旧强度，使用新模型默认行为；不凭空映射 high/max 等值。空 effort 保留现有“未指定请求强度”语义，与后续“恢复默认”操作区分。

支持强度列表和请求适配器必须共同允许才向 API 发出该字段；目录声明支持但适配器未接线的能力不能假装生效。宿主注入自定义 client 时，可使用其显式声明的能力；不能强迫自定义客户端一定出现在在线模型目录中。

### 历史与上下文

模型切换不清空历史，不重跑工具，不更换 session/run/input ID。新客户端根据目标协议转换已有结构化消息。推理回传等 provider 私有字段按来源与目标能力处理，不能盲目跨 provider 回传，也不能为了切换删除持久化原始历史。

新模型上下文更小时，压缩阈值必须使用目标模型的限制；不能仅刷新 UI 的上下文统计。如果压缩失败后仍无法满足限制，应明确失败，不能静默截掉工具配对结果或无限重试。已有图片/附件对新模型不兼容时，在发出请求前给出具体原因；不偷偷丢弃附件。

### 错误处理

保存前可判定的非法 model/provider/effort 或生命周期冲突：返回错误，不保存、不递增有效配置版本。

保存后、请求前的配置准备失败：不把新旧字段混合使用；记录一次脱敏配置错误。daemon 只有在失败 revision 仍是最新版本时，才用新的 revision 恢复上一次可用选择并发布 session 更新；如果已有更新版本，不能用旧失败覆盖它。SDK 内存存储遵守相同条件恢复规则。后续请求可继续使用仍被允许的旧配置；凭证被明确撤销时不得绕过撤销复用旧凭证。

首次创建或恢复时没有已准备好的旧配置，失败则直接返回明确错误，不虚构一个旧模型继续运行。恢复配置采用完整替换请求字段的方式，清除新配置独有的 provider/baseUrl/effort；不能用只追加字段的 patch 留下新旧混合值。

新配置已经开始实际 API 请求后发生鉴权、网络或服务端错误：走正常请求失败流程，不静默切回另一模型重新发请求。

## 界面与记录

- 不新增“待生效”“已生效”文案、状态图标、成功 toast 或额外状态栏。
- 保存成功后选择器采用服务端规范化后的目标配置；快速连续操作用请求序号防止较早响应覆盖较新选择。
- 配置读取、会话事件推送与 HTTP 响应不能乱序覆盖新 revision；运行中失败只通过既有错误出口反馈一次。
- 现有模型切换分割线继续复用，但改为在新模型首次实际用于请求时写入，不在“保存选择”时误报已经使用。仅 effort 变化不新增分割线。
- 请求开始记录 revision、model、provider、effort 的脱敏摘要；摘要不进入模型上下文。相同 model ID、不同 provider 的实际请求也能从记录中区分。
- 输出消息关联实际请求配置，不能从可能已变化的 `session.model` 推断本条消息使用了哪个模型。
- 空闲会话多次改选择但没有请求时，不制造多条模型使用记录。恢复历史后，从最近实际请求记录判断下一次是否需要分割线；旧历史无记录时不虚构切换。

## 第二阶段的明确要求

模型和供应商的选择以会话为准。桌面新会话沿用最近使用的有效会话的模型与供应商组合；没有可用会话时才使用现有默认值。供应商设置页管理连接，不提供“设为当前”的操作。其他全局与项目设置保留现有优先级；环境变量与启动参数在当前进程中不新增外部热修改机制。

新会话把所选模型与供应商组合写入自己的运行配置。已有会话继续使用各自保存的选择，切换会话模型不修改全局设置。模型与供应商只在会话里成对切换，避免重名模型路由到错误供应商。其余需要跟随文件默认值的字段另行标记；旧会话没有标记时保守保留原行为。

文件同步使用 Node 原生能力：监听文件所在目录以支持原子替换，合并短时间内的多次事件，并在请求边界校验文件指纹以补偿漏报。只订阅用户配置和实际打开项目的配置，停止 daemon 时释放监听。文件不存在使用正常继承规则；JSON 暂时无效保留上一份有效配置并反馈一次错误；有效内容恢复后自动继续同步。

设置页面、CLI 写配置和手动文件修改共用校验/差异应用流程，不能各自维护字段分类。文件中的模型与供应商变化不改写现有会话选择；其他动态字段只影响实际继承被改值的会话，项目 A 的文件不改变项目 B 的运行。配置未变化不递增 revision、不重建客户端。新增字段热更新前检查 prompt、请求、压缩、子 Agent、上下文统计等实际消费者。

## 第三阶段的明确要求

MCP 新连接先准备，再让后续请求看见新工具；已有工具调用继续使用捕获的绑定。旧连接在使用者释放后关闭。插件新旧版本、工具名冲突和卸载进行中的调用按相同原则处理。

当前 `RunCapabilityView` 固定在 run 粒度，热插拔需要让后续请求取得新视图，并让已发出的工具请求保留原视图。权限收紧在下一次工具实际执行前重新检查；权限放宽不能自动追认已拒绝的操作，也不能绕过宿主上限。此处不扩展执行环境切换。

## 第一阶段验收

1. 模型流尚未结束时修改 model/effort 成功；旧流正常结束，工具只执行一次，同一 run 的下一次请求使用新值。
2. 连续 A → B → C，边界前没有请求 B 时只使用 A、C；较早响应或准备失败不覆盖 C。
3. effort 同时更新提示词与请求参数；不支持的显式值被拒绝；清空后请求不携带旧值。
4. provider 切换同时更新 model/client/强度解析/上下文限制，历史转换与附件检查通过；不发送混合配置。
5. 父 Agent 存在活跃子任务仍能修改自身配置；已有子任务保持原选择，新子任务继承已应用值。
6. idle、流式输出、工具执行、维护、取消、关闭、恢复历史分别遵守上述边界。
7. 会话选择持久化且独立；SDK 内存路径无需 server；多窗口不会把旧响应写回选择器。
8. 界面没有新增生效状态提示；错误有反馈；模型分割线与消息实际配置一致。
9. Native/WSL 等执行环境相关代码不因本需求发生行为变化。

对应第一阶段的任务和验证命令见 [实施计划](../plans/2026-09-21-runtime-configuration-updates-phase-1.md)。第二、三阶段不包含在第一阶段完成声明中。
