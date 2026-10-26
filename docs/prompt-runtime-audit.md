# 提示词运行入口

> 状态：当前提示词组装与诊断入口索引。调用流程按现有 Node Runtime 和 daemon 接线维护。

用户输入通过 CLI、TUI 或 Desktop 到达 daemon 后，由 Node Runtime 组装本次模型请求的系统提示词。CLI 的 print 与 TUI 启动都走 daemon 会话，不再各自维护 REPL 或旧 backend 的提示词刷新流程。

## 组装过程

1. `packages/agent-runtime/src/node/runtime/default-runtime.ts` 读取已经解析的设置、执行环境、当前技能和本轮实际工具列表。
2. 调用 `packages/prompts/src/index.ts` 的 `buildRuntimeSystemPrompt()`；该函数经 `buildPromptLayers()` 与 `renderPromptLayers()` 输出系统提示词。
3. 分层素材由 `packages/prompts/src/prompt-segments-assembly.ts` 汇集，包括身份、环境、权限、项目指令、用户资料与本地事实。只有实际工具齐备时才加入相应委派或后台任务说明。
4. 运行时把固定后的提示词交给模型请求。长期记忆检索、压缩摘要和历史消息有各自的注入时机，见[上下文与记忆索引](./context-memory-map.md)。

`settings.systemPrompt` 作为自定义指令加入 context 层，不替换基础身份与固定约束。分层顺序及个人资料的读取规则见[提示词分层](./prompt-layering-design.md)，此处只维护调用入口。

## 诊断入口

| 入口 | 实现位置 | 返回什么 |
| --- | --- | --- |
| `/context` 及上下文查询 | `packages/server/src/application/default-services/memory/context-service.ts` | 用 `buildPromptLayers()` 生成的预览和个人提示文件诊断 |
| `/profile` | `packages/server/src/application/default-services/configuration/profile-service.ts` | `SOUL.md`、`USER.md` 的状态及初始化结果 |
| 个人提示文件检查 | `packages/prompts/src/personal-prompt-files.ts` | 缺失、空、已加载、被阻断或读取失败 |

预览是诊断视图，不等于某次实际模型请求的完整输入。插件本轮可见性、会话设置和运行时工具过滤会影响实际请求，应结合当前 Run 与工具列表核实。

## 状态与新增代码

提示文件和项目事实按[上下文与记忆索引](./context-memory-map.md)指定的位置保存；生成的字符串属于本次运行，预览不会写回配置。完整提示词 override 是 SDK 显式传入的能力，不能用它解释普通设置的语义。

新增提示素材放在 `packages/prompts/src` 的对应分类，新的执行入口复用统一构建函数；诊断接口留在 Server 应用服务。不要在界面或 CLI 另建一份提示词拼装逻辑。已有的个人资料队列与未接入范围见[提示词分层](./prompt-layering-design.md)。
