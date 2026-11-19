# OMP 能力调研与 Vykor 讨论清单

> 状态：研究记录，供逐项讨论。
> 核对日期：2026-11-17。范围为公开资料和静态源码。编辑成功率、性能及 Windows 应用兼容性留待实测。

[meow 的帖子](https://x.com/meow2149/status/2122295418445021263)比较了同源的 Pi 和 Oh My Pi（OMP）。两者都支持扩展、会话和多模型。OMP 把代码导航、编辑、调试和浏览器操作等常用能力直接做进 Agent。X 的公开接口只返回了原帖开头，长文通过公开索引补齐。下文的具体工具行为以 [OMP 源码快照 `bf9a9fb`](https://github.com/can1357/oh-my-pi/tree/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1) 为依据，Vykor 现状以仓库 `8ca07da1e` 为参照。

这些编号可直接用于后续讨论。只选一项通用体验时，优先看 **14 运行耗时明细**。面向开发用户，**06 AI 审阅**能用现有差异面板较快交付，**01 真实 LSP**是代码理解最需要补的基础，**10 GitHub 链接**能缩短从接到问题到开始定位的路径。代码工具可以按真实 LSP、只读 AST 搜索、Hashline 试点的顺序验证。

## 议题目录

- 代码理解与编辑：[01 LSP](#01-真实-lsp)、[02 AST 搜索](#02-ast-搜索)、[03 AST 编辑](#03-ast-批量编辑)、[04 Hashline](#04-hashline-编辑)、[05 DAP](#05-dap-运行时调试)。
- 开发工作流：[06 AI 审阅](#06-ai-审阅改动)、[07 拆分 Git 提交](#07-拆分-git-提交)。
- 联网与操作：[08 搜索](#08-联网搜索)、[09 读网页](#09-url-正文读取)、[10 GitHub 链接](#10-github-链接作为上下文)、[11 浏览器](#11-浏览器自动化)、[12 电脑操作](#12-桌面软件操作)。
- 会话与长任务：[13 子任务](#13-子任务查看与介入)、[14 耗时明细](#14-运行耗时明细)、[15 会话导入](#15-导入其他助手的会话)、[16 模型选择](#16-按用途选择模型与失败回退)、[17 Python 工作区](#17-python-工作区)、[18 会话压缩](#18-snapcompact-会话压缩)。

## 01 真实 LSP

LSP 是语言服务器协议。Agent 给语言服务器一个文件和符号位置，由服务器根据项目的导入和类型关系返回定义、引用与诊断。OMP 会同步文件变化，收集修改后的诊断。跨文件改名由语言服务器给出改动，`apply: false` 可以预览。可用能力取决于项目中装好的语言服务器及其支持的操作。 [OMP LSP 操作](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/lsp.md) · [OMP 配置与发现](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/lsp-config.md)

Vykor 当前用正则提取符号，用 `rg` 搜同名文本，跳到定义复用文本命中。已有真实语言服务器的接入提案。第一版可以从 TypeScript 的定义、引用和诊断开始，按项目复用进程，返回能点开的文件和行号。用两个模块各有一个 `save()`、其中一个经过别名导入的例子验收，确认能找到正确的定义。 [Vykor 当前实现](../../packages/execution-node/src/lsp/README.md) · [Vykor LSP 提案](../lsp-client-design.md)

**讨论问题。** 第一版的诊断是按需查询，还是每次编辑后主动提示？Native 和 WSL 分别覆盖哪些项目？

## 02 AST 搜索

AST 是代码解析得到的结构。OMP 的 `ast_grep` 按语法节点搜索，例如 `console.log($$$ARGS)` 匹配实际的调用节点，`$$$ARGS` 代表任意数量的参数。语言和路径可以限定，解析错误会单独报告。要识别一次调用具体指向哪个模块或变量，可以结合 LSP。 [OMP AST 搜索](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/ast-grep.md)

Vykor 可以先提供只读的结构搜索，返回文件、行号和命中的代码片段。首批场景可以选查旧 API 调用、找循环中的 `await`，以及检查一类导入是否已经清理。 [Vykor 搜索工具入口](../../packages/tools/src/search/README.md)

**讨论问题。** 先支持 TypeScript 和 TSX，还是同步支持 Python？搜索结果是否需要在桌面里点开定位？

## 03 AST 批量编辑

OMP 的 `ast_edit` 先生成预览，例如把一批 `console.log(...)` 调用替换为 `logger.debug(...)`。应用时会在最新文件上重新执行改写，再比较替换总数和每个文件的数量。返回「预览已过期」时，部分文件可能已经写入。带语法错误的文件会跳过。 [OMP AST 编辑](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/ast-edit.md) · [应用路径源码](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/tools/ast-edit.ts#L438)

Vykor 可以复用差异面板和现有文件修改入口。生成预览时记录目标文件版本，应用时在写入前复核。遇到版本变化，重新生成差异供用户查看。第一次试点适合边界清楚的 API 迁移，验证批量修改后还能让语言服务器检查导入和类型。 [Vykor 差异面板](../../apps/desktop/src/renderer/src/components/desktop/tools/review/README.md) · [Vykor 文件编辑与补丁](../../packages/tools/src/file/editing/README.md)

**讨论问题。** 第一版支持逐文件确认还是整批确认？发生部分写入失败时，界面如何标出已写入的文件？

## 04 Hashline 编辑

OMP 当前给 Agent 的是文件快照标签和原始行号，例如 `[auth.ts#A1B2]` 下的第 42 行。Agent 提交目标行和新内容。默认会检查目标行是否已展示过。如果用户在文件顶部插入了几行，OMP 会尝试从保存的快照恢复唯一对应位置。没有安全匹配时返回冲突和附近的新内容。 [OMP 编辑格式与快照恢复](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/edit.md)

Vykor 的 `Edit` 已支持可选 `expected_sha256`，并有文件修改锁、快照复核和冲突提示。可以在现有 `Read` 与 `Edit` 上增加可选的按行定位。用重复代码、长文件以及用户同时改文件三类场景，比较同一模型的首次编辑成功率、重试次数和输出用量。 [Vykor Edit 实现](../../packages/tools/src/file/editing/edit.ts) · [文件操作保护](../../packages/tools/src/file/README.md)

**讨论问题。** 第一版遇到旧版本直接让 Agent 重读，还是也试做安全的行号恢复？哪些模型适合先试？

## 05 DAP 运行时调试

DAP 是 Agent 与调试器通信的协议。OMP 的 `debug` 可以启动或附加到进程、设断点、单步执行、读调用栈和局部变量。常见适配器包括 Python 的 `debugpy`、Go 的 Delve 和 C/C++ 的 `lldb-dap`，实际运行依赖执行环境中的调试器。例如 Python 函数只在特定输入下返回空值，Agent 可以在返回前停住，拿到参数和分支条件。 [OMP 调试工具](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/debug.md) · [适配器配置](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/dap/defaults.json)

这项适合有具体故障场景时再做。Vykor 可以先挑一种语言和一个稳定复现的例子，跑通启动、断点、读变量、停止，并确认会话结束后调试进程能收尾。 [Vykor 执行环境](../sandbox-runtime-flow.md)

**讨论问题。** 首个场景选 Python 逻辑错误、Node 服务异常，还是其他当前常遇到的问题？

## 06 AI 审阅改动

OMP 的 `/review` 按选中的改动范围发起审阅，按严重程度返回问题和结论；`/annotate code-review` 可以把用户的行内批注一起提供给审阅者。Vykor 有 Git 差异面板、选区引用和只读审阅 Agent，可以从现有面板直接发起。 [OMP 审阅入口](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts) · [OMP 批注处理](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/extensibility/custom-commands/bundled/review/prompt.ts) · [Vykor 选区引用](../../apps/desktop/src/renderer/src/components/desktop/tools/review/review-diff-preview.tsx) · [Vykor 只读审阅角色](../../packages/coordinator/src/definitions/builtin.ts)

第一版从当前打开的差异发起，按严重程度列出问题。点问题跳到对应行，再把选中的问题发回当前聊天处理。

**讨论问题。** 首版覆盖未提交改动就够，还是同时支持比较分支和单个提交？审阅结果关联到哪一版差异？

## 07 拆分 Git 提交

OMP 能读工作区和代码片段的差异，提出按依赖顺序排列的提交方案。Vykor 可以从现有 Git 差异面板生成可编辑的草案，展示每组文件或代码片段、提交消息和顺序。比如把混在一起的「修登录」「补测试」「更新文档」分组，让用户核对后确认。 [OMP 拆分提交工具](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/commit/agentic/tools/split-commit.ts) · [Vykor Git 接口](../../packages/server/src/http/routes/git.ts)

**讨论问题。** 先做到提交建议，还是第一版就允许确认后执行？同一文件的多段改动如何在界面上拆分？

## 08 联网搜索

OMP 的 `web_search` 按配置尝试可用服务，拿到首份可用结果后返回来源链接、摘要和可用引用。默认优先尝试 Parallel，后续候选包括模型自带搜索、Exa、Firecrawl 和 DuckDuckGo。每次查询会送到实际尝试的服务，凭据和费用由所选服务与配置决定。限定 X 站点或作者的查询会优先尝试可用的 xAI 搜索。 [OMP 搜索路由](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/web_search.md)

Vykor 当前的默认搜索走 DuckDuckGo。可以保留统一结果格式，增加可配置的主服务和备用服务，并在结果里显示实际来源和回退原因。 [Vykor 默认联网配置](../../packages/tools/src/web/default-runtime.ts)

**讨论问题。** 现有搜索最常遇到的是缺结果、速度慢，还是特定站点覆盖差？先加哪个搜索服务能解决问题？

## 09 URL 正文读取

OMP 的 `read` 会给已知站点使用专门的读取方式，能提取 PDF 文本，也会尽量保留普通网页的标题、正文和链接。对于本次原帖所在的 X，专用入口通过 Grok 的 `x_search` 获取内容并由模型转述，需要 xAI 登录或 API Key。需要保持登录状态、执行页面脚本或点击交互时，可转到浏览器。 [OMP URL 读取](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/read.md) · [X 读取源码](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/web/scrapers/twitter.ts)

Vykor 已有网页抓取入口。可以优先增加常用站点和文档格式的处理，返回来源、可引用的段落，以及登录页、拦截页或正文提取失败的具体状态。 [Vykor 网页工具](../../packages/tools/src/web/README.md)

**讨论问题。** 先做技术文档和 PDF，还是先解决 X 等动态站点？网页需要登录时，交接给浏览器的入口放在哪里？

## 10 GitHub 链接作为上下文

OMP 把 Issue、PR、评论和差异暴露为可分段读取的资料。例如 `pr://1428` 读取 PR，再按范围查差异。Vykor 可以从输入框识别 Issue 或 PR 链接，展示标题和状态，按任务需要加载评论、差异或检查结果。典型场景是「贴 Issue，根据复现步骤查本地代码」和「贴 PR，解释 CI 检查为什么失败」。 [OMP GitHub 资料读取](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/internal-urls/issue-pr-protocol.ts)

**讨论问题。** 先支持公开仓库，还是同步支持已登录的私有仓库？第一版以 Issue 定位和 PR 检查失败中的哪条流程验收？

## 11 浏览器自动化

OMP 在 JavaScript 或 Python 的 Eval 执行环境里提供浏览器接口。Agent 打开一个命名标签页，读取按钮和输入框，执行点击或填写，等页面变化，再查控制台、网络请求或截图。可用 OMP 管理的浏览器，也能通过扩展连接用户自己的 Chrome 标签页。浏览器观察也要经过 OMP 的执行权限策略。 [OMP 浏览器接口与权限](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/browser.md)

Vykor 已有内嵌浏览器、网页批注、页面操作和控制台与网络诊断。可以把这些能力串成可重复的网页验证流程。比如修完本地表单后点「保存」，等待反馈，检查对应请求状态，最后附截图或失败证据。 [Vykor 浏览器接入](../../packages/server/src/application/browser-tools/README.md) · [Vykor 浏览器开发工具](../../packages/server/src/application/browser-tools/browser-developer-tool.ts)

**讨论问题。** 首先验证本地开发页还是登录后的业务页面？步骤和证据以聊天结果、可重跑记录，还是两者同时呈现？

## 12 桌面软件操作

OMP 的 `computer` 操作运行 OMP 的机器。它能找窗口、截图、读操作系统提供的控件结构、点击、键入、按快捷键或访问剪贴板。控件信息不足时，可以按截图坐标操作。Windows 上使用原生窗口捕获、Win32 输入和 UI Automation；有些窗口控件需要切到前台。 [OMP 电脑操作与平台差异](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/computer-use.md)

OMP 默认关闭这项能力，交互会话可用 `/computer on` 开启。窗口输入会先尝试后台路径，默认允许短暂切到前台，用户可以选 `refuse`。在 `tools.approvalMode: write` 下，读取与截图直接进行，输入和改动走审批。`computer.run` 的 `read_only` 约束桌面接口，脚本仍有宿主运行权限。Vykor 若要试做，可从选定 Windows 窗口开始，验证读控件、截图、单次操作和用户中断。 [OMP 开关与配置](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/computer-use.md#enable-and-configure)

**讨论问题。** 哪个桌面软件有需要实际验证的流程？前台切换是由用户逐次决定，还是由会话设置控制？

## 13 子任务查看与介入

OMP 的 Agent Hub 能看子任务正在做什么、读实时记录、追加指令、单独停止或重新唤醒。它也支持让子任务使用独立工作目录，并返回校验过的结构化结果。Vykor 有任务列表、活动状态、子会话详情、独立工作目录和子任务发送与停止能力。可以先在原详情里接上「补充指令」「停止此任务」，再把任务输出和改动放到同一处。 [OMP Agent Hub](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/agent-hub.md) · [OMP 任务工具](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/tools/task.md) · [Vykor 子任务面板](../../apps/desktop/src/renderer/src/components/desktop/tools/agents/README.md) · [Vykor 任务接口](../../packages/tools/src/job/job-tools.ts)

**讨论问题。** 运行中补充和结束后继续是否共用一个输入框？任务改动从子详情打开，还是汇到主会话的改动面板？

## 14 运行耗时明细

OMP 的 `/trace` 可以按模型请求、工具调用和子任务看时长，并跳回对应消息。Vykor 已有耗时、模型、工具、用量和失败类别等后台记录。首版可以在单轮对话旁提供「查看耗时」，展示耗时最长的几步，区分等待模型、执行工具和可观测的审批等待，再点回聊天。 [OMP Trace 与消息定位](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/session-operations-export-share-fork-resume.md#export-and-dump) · [Vykor 运行观察数据](../../packages/protocol/src/runtime/execution-observability.ts)

**讨论问题。** 首版做单轮耗时清单就够，还是要显示跨轮和并行子任务的时间线？历史记录缺时间时怎样呈现？

## 15 导入其他助手的会话

OMP 的 `/resume @claude` 和 `/resume @codex` 可以选择外部会话，转换成新的 OMP 会话继续工作。Vykor 已有 Markdown 和 JSON 导出，可以另加「导入为新聊天」入口。先预览任务目标、改动、验证结果和待办，用户确认后带入。旧工具调用作为历史资料，接下来的操作按当前会话权限执行。 [OMP 会话操作](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/session-operations-export-share-fork-resume.md) · [Vykor 会话导出](../../packages/server/src/session/export-session.ts)

**讨论问题。** 先接 Codex 还是 Claude Code？导入原始消息、交接摘要，还是让用户选择其中一种？

## 16 按用途选择模型与失败回退

OMP 可以给默认对话、规划、轻量任务等用途指定模型，也支持按角色配置限流或额度耗尽后的备用模型。Vykor 的 Agent 角色已支持指定模型，子任务也能继承父运行实际使用的模型。可以把「资料整理」「执行」「审阅」做成可见的配置项，运行记录显示切换原因和实际使用的模型。 [OMP 模型与路由](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/models.md) · [Vykor 角色定义](../../packages/coordinator/src/definitions/types.ts) · [Vykor 子任务模型选择](../../packages/agent-runtime/src/node/children/README.md)

**讨论问题。** 先做按用途配置，还是把失败回退一起做？哪些错误可以自动切换，哪些需要把决定留给用户？

## 17 Python 工作区

OMP 的 Python 执行进程可以跨多次调用保留变量，还能从代码里调用受宿主控制的 Agent 工具。Vykor 当前的 Notebook 工具负责读取和编辑单元格。可以先验证一个数据分析流程：上传表格、清洗、画图、继续追问，当前聊天重复使用中间数据并导出脚本和图表。 [OMP Python 执行进程](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/eval/py/kernel.ts) · [OMP Python 工具桥接](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/packages/coding-agent/src/eval/py/tool-bridge.ts) · [Vykor Notebook 工具](../../packages/tools/src/notebook/README.md)

**讨论问题。** 工作区变量保留到哪一刻？机器重启后是否需要通过保存的脚本和输入文件恢复？

## 18 Snapcompact 会话压缩

OMP 可以把旧历史渲染为紧凑图片，交给支持图像输入的模型，帮助长对话继续。它也有预压缩裁剪和持久记忆能力。Vykor 已有文本压缩、会话连续性记录和项目记忆。Snapcompact 适合等遇到具体的长会话问题再试，在相同模型和任务上比较用量、延迟，以及对旧代码、路径和数字的回忆准确性。 [OMP 会话压缩](https://github.com/can1357/oh-my-pi/blob/bf9a9fbd40e96766d528a9f19a603e53e8c0b5a1/docs/compaction.md#snapcompact-method) · [Vykor 压缩流程](../compact-service-design.md) · [Vykor 上下文与记忆](../context-memory-map.md)

**讨论问题。** 当前长会话的问题主要是成本、压缩等待，还是继续执行时丢失细节？哪类实际任务可作为对照？
