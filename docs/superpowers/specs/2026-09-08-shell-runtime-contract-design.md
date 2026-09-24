# Shell 运行时契约设计

**状态：** 已实施，已完成定向验证  
**日期：** 2026-09-08  
**范围：** Vykor Agent Runtime、Shell Tool、Execution Environment、Desktop 展示
**取代：** `docs/superpowers/plans/2026-09-08-cross-platform-shell-consistency.md` 中以扩充方言正则为主的方向

## 1. 结论

Vykor 应将当前模型可见的 `Bash` 工具直接替换为中性的 `Shell` 工具，不注册 `Bash` 兼容别名。

Shell 类型由 Execution Environment 在会话启动时确定并验证。工具名称、模型说明、执行器、权限判断、结果元数据和 UI 必须共用同一份 Shell 描述，不得各自推测。

不修改第三方技能的文档或示例。技能可以使用 Bash、PowerShell 或其他平台风格的示例，运行时负责向模型明确当前环境，模型负责生成当前 Shell 的原生命令。

## 2. 问题证据

2026-09-08 的“AI圈有什么新鲜事”会话正确读取了用户级 `ai-radar` 技能，位置为：

```text
C:\Users\ruanz\.vykor\skills\ai-radar\SKILL.md
```

该会话的工具执行统计：

| 工具 | 成功 | 失败 |
|---|---:|---:|
| Skill | 1 | 0 |
| Bash | 17 | 17 |
| BackgroundShellCreate | 2 | 0 |
| WebFetch | 3 | 0 |
| Grep | 1 | 0 |
| Read | 1 | 0 |

17 次 Shell 失败包括：

- 5 次 PowerShell 与 `python -c` 多层引号交叉后产生的 Python `SyntaxError`；
- 4 次在 PowerShell 中执行 Bash heredoc；
- 4 次 Python `urllib` 请求返回 HTTP 403；
- 2 次 PowerShell `param` 位置错误；
- 1 次使用 Windows PowerShell 5.1 不支持的 `??`；
- 1 次内联 Python/f-string 被 PowerShell 管道解析破坏。

对照 Codex 执行同一技能时，它使用 `curl.exe`、`Get-Content -Raw -LiteralPath`、`ConvertFrom-Json`、`Sort-Object` 和 `Group-Object` 组成 PowerShell 原生数据流。它没有修改技能，也没有将大段 Python 嵌入 `python -c`。

## 3. 设计原则

### 3.1 运行环境是唯一事实来源

Shell 可执行文件、方言、版本、路径格式和能力必须由运行环境探测。模型、工具和 UI 不得从操作系统名称、工具名或命令文本反推它。

### 3.2 工具契约必须中性

`Bash` 名称会向模型暗示 POSIX/Bash 语法，而工具实际在 Windows 上可能调用 PowerShell 或 cmd。新名称统一为 `Shell`。

新工具不注册 `Bash` 别名。旧会话中已持久化的 `toolName: "Bash"` 只作为历史展示数据保留，不恢复为可调用工具。

### 3.3 动态说明代替静态猜测

Shell 工具的模型可见说明由当前 `ShellDescriptor` 生成。例如 Windows PowerShell 5.1 会话中，说明只提供 PowerShell 5.1 的可用语法和常用原生命令；WSL 会话中则提供 POSIX Shell 说明。

### 3.4 不建设方言修补系统

方言分析主要用于权限和安全分类，不用于维护一张不断增长的“Bash 语法→PowerShell 语法”对照表。

可以拒绝能确定无法在当前 Shell 解析的高置信命令，但不把这层当作命令生成器，也不对 `grep`、`curl.exe`、`python` 等外部程序做简单的方言归类。

### 3.5 失败必须收敛

相同命令或相同错误指纹不得无限重试。已有工具成功获得目标数据后，不应换用其他工具重复获取。

## 4. 核心模型

```ts
export interface ShellDescriptor {
  family: "powershell" | "cmd" | "posix";
  dialect: "windows-powershell" | "pwsh" | "cmd" | "bash" | "posix-sh" | "zsh";
  executable: string;
  argsPrefix: string[];
  displayName: string;
  version?: string;
  pathStyle: "windows" | "posix";
  tempDir: string;
  capabilities: {
    conditionalAndOr: boolean;
    supportsLoginShell: boolean;
  };
}
```

`executable` 只保存程序路径，`argsPrefix` 保存 `-NoLogo -NoProfile -Command`、`-lc` 等启动参数，不得把“程序+参数”拼成一个显示字符串当作执行契约。

`version` 和 `capabilities` 来自启动探测，而不是从文件名猜测。例如 PowerShell 7 支持 `&&`/`||`，Windows PowerShell 5.1 不支持；工具说明应反映实际能力。输出编码由 process adapter 按 Shell 输出、native 子进程 stdout/stderr 和当前 code page 处理，不压缩成 ShellDescriptor 的单一布尔值。

首期支持 Windows PowerShell 5.1、PowerShell 7、cmd、`/bin/sh`、bash 和 zsh。fish 不是 POSIX Shell，Windows Git Bash 同时涉及 MSYS 与 Windows native program 的路径翻译，二者不在首期支持范围。

### 4.1 结果元数据

ShellDescriptor 是运行时内部契约；会话持久化与 UI 消费统一使用：

```ts
export interface ShellResultMetadata {
  shellFamily: ShellDescriptor["family"];
  shellDialect: ShellDescriptor["dialect"];
  shellExecutable: string;
  shellDisplayName: string;
  pathStyle: ShellDescriptor["pathStyle"];
  exitCode: number | null;
  status: "completed" | "failed" | "timed_out" | "interrupted";
}
```

`argsPrefix`、环境变量和其他启动细节不写入会话记录，避免泄露环境信息。新结果只写上述字段。历史数据中的 `shell`/`shellDialect` 由读取层兼容，不改写历史记录。

## 5. 启动与执行流程

```text
会话启动
  → Execution Environment 解析候选 Shell
  → 启动最小探测命令
  → 产生不可变 ShellDescriptor
  → 将 descriptor 写入 ExecutionEnvironmentHandle.info
  → 生成当前 Shell 专属的工具说明
  → 用 descriptor factory 注册 Shell 和 BackgroundShellCreate
  → 组装模型环境上下文

工具调用
  → 校验 workdir 和权限
  → 用 [ShellDescriptor.executable, ...argsPrefix, command] 执行
  → 分开采集 stdout/stderr
  → 返回 ShellResultMetadata
  → 会话投影持久化 metadata
  → Desktop 显示真实 Shell
```

执行期间不允许静默切换到另一种 Shell。指定 Shell 不存在或探测失败时，应在会话启动或工具调用时返回明确错误。

### 5.1 唯一拥有者与现状迁移

`ExecutionEnvironmentHandle.info.shellDescriptor` 是唯一拥有者。实施时必须同时完成：

1. 将 Local/WSL Shell 解析收敛到 Execution Environment 创建阶段。
2. 删除 Prompt 模块内独立的宿主 Shell 再探测路径。
3. 将静态 `bashTool` singleton 改为接收 ShellDescriptor 的 tool factory。
4. `createDefaultToolRegistry` 在获得 Execution Environment 后才创建 Shell 类工具。
5. 前台 Shell、BackgroundShellCreate、hook command 和 workflow 中的 Shell command 共用同一 descriptor 和 process adapter。
6. Desktop 集成终端是用户可交互的独立能力，可有用户选择的 Shell，但不得反向改变已启动 Agent 会话的 descriptor。

## 6. 模型可见的 Shell 工具

```ts
{
  name: "Shell",
  description: createShellDescription(shellDescriptor),
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { type: "string" },
      timeout: { type: "number" }
    },
    required: ["command"]
  }
}
```

Windows PowerShell 5.1 的说明至少包含：

```text
This tool executes commands with Windows PowerShell 5.1.
Use PowerShell syntax and Windows paths.
Prefer native PowerShell pipelines for object and JSON processing.
Use curl.exe when the native curl executable is intended.
Avoid embedding multiline programs in python -c.
Do not use Bash heredoc syntax.
```

PowerShell 7、cmd 和 POSIX Shell 分别生成自己的说明。说明中不出现“Windows 上可能是 Bash、PowerShell 或 cmd”这种要求模型再猜一次的表述。

## 7. 第三方技能边界

Vykor 不改写第三方 `SKILL.md`，不在安装时替换命令示例，不为某个具体技能注入特例。

技能与环境冲突时，模型应保留技能的目标和数据流，把命令翻译成当前 Shell 的原生写法。例如：

```text
curl + python heredoc 读 JSON
  → PowerShell: curl.exe/Invoke-RestMethod + ConvertFrom-Json
  → POSIX: curl + jq/python heredoc
```

这是 Agent Runtime 的一般环境适配能力，不是 `ai-radar` 的专用修复。

## 8. 错误恢复契约

运行时将失败归一化为：

```ts
interface ShellFailure {
  kind: "spawn" | "exit" | "timeout" | "permission" | "runner" | "interrupted";
  fingerprint: string;
  shell: ShellDescriptor;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
```

Shell Tool 只报告它能客观确定的进程事实。它不从任意 stderr 推测 `network` 或 `parse`，也不判断两条命令是否在获取同一份数据。

恢复规则：

1. Query Engine 仅在同一 run 内维护 `{ normalizedCommand, lastFailureFingerprint, attemptCount, evidenceRevision }`。完全相同的命令在 `evidenceRevision` 未变化时再次调用，直接返回上次失败摘要，不重新启动进程。
2. “同一执行路线”和“目标数据已获取”由 Agent/Query 层通过提示纪律与轨迹评测约束，不在 Shell Tool 中做不可靠的语义猜测。
3. 简单 JSON 查询在 PowerShell 中优先使用 `ConvertFrom-Json`，不创建第二层 Python 引号环境。该条写入 PowerShell 动态工具说明。
4. 返回给模型的失败必须分离 stdout 与 stderr；process adapter 负责实际编码解码。
5. 以下事件会提升 `evidenceRevision` 或清除去重状态：权限决策改变、Shell/环境配置改变、workdir 改变、新的工具结果提供了相关证据、用户显式要求重试。
6. `timeout`、`spawn` 和明确的临时 runner 失败允许 Query Engine 自动进行一次受控重试；命令退出码失败默认不自动原样重试。

## 9. 命名迁移

### 9.1 可调用工具

- 从注册表删除 `Bash`。
- 注册 `Shell`。
- 不注册别名，不在未知工具时将 `Bash` 重定向到 `Shell`。

### 9.2 内部配置

一次性更新以下内部名称：

- 默认工具注册；
- 权限允许/禁止列表；
- 子代理允许工具；
- Workflow 工具白名单；
- 基础提示和背景任务提示；
- Desktop 工具分类与通知；
- 所有测试固定值。
- `autoApproveTools`、`permission.rules[].tool`、`hostToolCeiling`、`roleAllowedTools` 和 `disallowedTools`；
- 会话级 approval 复用键；
- hook 和插件 hook 的 `tool_name`/`matcher`；
- 指标、导出、compact worklog 和其他按 toolName 聚合的消费者。

所有 Vykor 自有的持久化配置在读取时 canonicalize `Bash`→`Shell`，下次保存写回新名。已发放但未使用的会话级 approval 按旧 toolName 作废，不自动扩大为新工具权限。

hook 的 `matcher: Bash` 在加载时迁移为 `Shell`，并记录一次弃用警告。这只迁移 Vykor 对工具名称的引用，不改写第三方文件。

内置名 `Shell` 和历史名 `Bash` 都为保留工具名：插件不得注册或覆盖它们。插件尝试注册时在加载阶段明确失败，避免模型可见工具重名。

### 9.3 历史会话

历史记录不改写。Desktop 展示层可将历史 `Bash` 视为“Shell 类工具记录”，并优先根据已持久化的 `shellDialect` 显示实际 Shell。这不会让模型再次调用 `Bash`。

CLI 展示、轨迹导出、compact worklog 和 metrics 同样保持“历史原样，新数据只写 Shell”。

### 9.4 第三方工具声明

当 Vykor 将来开始消费第三方技能的结构化工具约束时，Skill loader 必须对工具名 token 做 canonicalize：`Bash`→`Shell`，同时保留 `Bash(npm *)` 中的 `(npm *)` 约束后缀。当前 SkillDefinition 尚未把该字段解析为 typed allowed-tools，因此这是未来解析器的边界要求，不是首期迁移任务。技能正文里的普通文本和代码块始终不做替换。

## 10. 三端行为

| 环境 | Shell 事实 | 命令风格 | 路径 | 临时目录 |
|---|---|---|---|---|
| Windows Native | 显式配置的受支持 Shell；未配置时 `pwsh.exe`→`powershell.exe`→`cmd.exe` | PowerShell 或 cmd 原生 | Windows | `env.tempDir` |
| macOS | 实际解析的 POSIX Shell | POSIX | POSIX | `env.tempDir` |
| Linux | 实际解析的 POSIX Shell | POSIX | POSIX | `env.tempDir` |
| WSL | WSL 内的 `/bin/sh` 或配置 Shell | POSIX | POSIX | WSL `env.tempDir` |

Windows 宿主上的 WSL 不按 Windows Native 处理；以 Execution OS 和 ShellDescriptor 为准。

Windows Native 默认不再优先自动发现的 `bash.exe`。Windows Git Bash 的路径翻译契约在后续独立设计中处理；首期不将它声明为支持的 Agent Shell。

## 11. 黑盒验收

使用原样第三方 `ai-radar` 技能，分别在 Windows Native、macOS、Linux 和 WSL 执行“AI圈有什么新鲜事”。

验收条件：

1. 模型可见工具中存在 `Shell`，不存在 `Bash`。
2. 不改动 `SKILL.md`。
3. Windows PowerShell 轨迹不出现 Bash heredoc、`/tmp` 或未显式的 Bash 控制语法。
4. POSIX 轨迹不出现 PowerShell cmdlet、`$env:` 或 Windows 路径操作。
5. 第一条获取路线失败后最多切换一次备用路线。
6. 成功获取目标 JSON 后不再重复下载。
7. 同一错误指纹不连续出现。
8. Shell 工具结果包含完整 `ShellResultMetadata`。
9. Desktop 显示的 Shell 与执行器一致。
10. Windows 中文 stdout/stderr 无乱码。

建议为黑盒轨迹设置基线：默认整个任务 Shell 调用不超过 8 次，Shell 失败不超过 2 次。该阈值是评测目标，不作为生产环境强制中断条件。

## 12. 测试策略

### 单元测试

- Shell 探测：可执行、不可执行、错误 PATH 别名、明确配置。
- 动态说明：PowerShell 5.1、PowerShell 7、cmd、POSIX。
- 工具结果：成功、命令失败、超时、中断、runner 失败。
- 配置迁移：`Bash` 权限项变为 `Shell`，不产生双工具。
- 历史展示：旧 `Bash` 记录可读，新调用只有 `Shell`。
- process adapter 编码：PowerShell cmdlet 输出与 native 子进程 stdout/stderr 分别验证中文。

### 集成测试

- Environment 探测→Prompt→Tool Registry→Executor→Transcript→Desktop 全链路。
- Native Windows 和 WSL 在同一宿主上产生不同的 ShellDescriptor。
- 指定 Shell 无法启动时显式失败，不静默切换。
- stdout/stderr 分离并按实际 Shell 编码解码。

### 黑盒评测

- 阻塞 CI 使用 fake model、本地 HTTP fixture 和固定 tool calls，覆盖 Windows PowerShell 5.1/7、cmd、macOS/Linux POSIX；WSL 仅在 runner 可用时运行。
- 将当前 34/17 轨迹保存为离线回放 fixture，验证重复命令/错误指纹识别。
- 真实模型+公网黑盒 eval 为非阻塞评测：固定模型、推理强度和技能版本，每端至少 10 次。
- 评测记录调用数、失败数、重复指纹、完成时间和最终结果正确性，与 34/17 基线比较。
- “路线切换”和“目标数据”指标在加入自动断言前，先定义 trace 中的 `routeId` 和 `targetId`。

## 13. 不在范围内

- 修改 `ai-radar` 或其他第三方技能。
- 为特定技能内置命令翻译器。
- 只为 Windows 引入的特例执行器。
- 通过静默切换 Shell 掩盖配置错误。
- 保留可调用的 `Bash` 兼容别名。
- 在本设计阶段实施代码。

## 14. 开源调研参考

- OpenAI 模型工具指导：<https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2>
- Codex Shell 命令解析：<https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/parse_command.rs>
- Codex 执行策略：<https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs>
- Codex Windows Shell 配置讨论：<https://github.com/openai/codex/issues/16579>
- Codex PowerShell 可执行文件解析问题：<https://github.com/openai/codex/issues/18937>

## 15. 已确定的实施决策

1. 模型可见名称使用 `Shell`。
2. Windows Native 先尊重显式配置；未配置时优先经验证的 PowerShell 7，再回退 Windows PowerShell 5.1，最后回退 cmd。
3. Query Engine 负责 exact command+失败指纹去重；Agent/Prompt/Eval 负责语义路线收敛；Shell Tool 只返回结构化进程事实。
4. BackgroundShellCreate 与前台 Shell 共用会话 ShellDescriptor，不自行重新选择 Shell。

## 16. 实施验证记录

2026-09-08 实施后的验证：

- `pnpm check-types`：59/59 Turbo 任务通过。
- Environment 契约测试：4/4 通过。
- Sandbox 定向 Shell/WSL 测试：12/12 通过。
- Tools Shell/Registry/Background 定向测试：通过。
- Core Query Engine 与失败记忆：47/47 通过。
- Prompt：49/49 通过。
- Coordinator：99/99 通过。
- Server transcript 投影：15/15 通过。
- Desktop message model：13/13 通过。
- 脱敏 34/17 轨迹评测：2/2 通过。

已知、独立记录的全仓基线问题：

- `packages/sandbox/e2e/wsl.e2e.test.ts` 在真实 WSL PTY/中断时序上不稳定；多次运行分别出现 AbortSignal 10 秒超时，以及 PTY 中断后未在等待窗口收到 `after-interrupt`。
- `pnpm build` 被 Desktop 两个既有类型错误阻断：`runtime-setting-model.ts` 未使用参数，`terminal-tool.tsx` 的 `scope` 可空性与 `UserTerminalCreateInput` 不一致。
- 根命令 `pnpm lint` 因 Turbo 配置中不存在全局 `lint` 任务而无法运行。
