# 工具权限检查

公开入口为 `@vykor/permissions` 的 [index.ts](index.ts)。本包给出调用决策，宿主据此执行工具或询问用户。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `PermissionChecker`、只读工具集合、路径与命令匹配，并转导出配置解析和决策类型 |
| [effective-permission-mode.ts](effective-permission-mode.ts) | `effectivePermissionMode()`，将审批和工作模式映射为底层模式 |
| [shell-commands.ts](shell-commands.ts) | 保守识别字面 Shell 命令边界，不执行命令、不展开变量 |
| [__test__](__test__) | 模式、拒绝优先级、路径规范化和冲突输入测试 |

`checkTool()` 先统一工具名并检查路径别名冲突，再检查工具拒绝名单、计划模式限制、命令与路径拒绝规则，随后计算显式规则和允许条件，最后返回 `allow`、`deny` 或 `ask`。路径按指定的 `pathStyle` 和 `cwd` 处理。

对 `Shell` 和 `BackgroundShellCreate`，宿主通过构造参数 `shellDialect` 提供实际解释器家族（POSIX、PowerShell 或 cmd），不读取模型输入里的同名字段。POSIX 和 PowerShell 的字面命令可按分号、换行、管道、`&&` 和 `||` 分开，每条分别走权限规则；任意一条拒绝则整次拒绝，否则任意一条需要确认则整次确认。完整原文的拒绝规则同样保留，但完整原文的允许规则不能授权后面的命令。因此 `git *` 不能直接授权 `git status; echo SECOND`，`deniedCommands: ["rm -rf*"]` 也能拒绝后段 `rm -rf ./dummy`。引号内的分号保持字面含义。允许规则匹配每段去掉首尾空白后的原文，保留引号与参数边界；`git status` 的精确允许规则不能授权 `"git status"` 这个含空格的可执行文件名。去掉字面引号和合并多余空格后的候选文本只用于保守命中拒绝规则。

PowerShell 的换行包括 `\r`、`\n` 和 `\r\n`；其他解释器或未知解释器遇到 `\r` 保守要求确认，不把它改成普通空格或通过去除首尾空白授权。`command`、`builtin` 和 `nohup` 会把执行转交给后面的程序，因此同其他间接执行入口一样要求确认。

这不是通用 Shell 解析器：命令替换、变量展开、重定向、通配符、反引号或反斜线转义、注释和脚本结构、`--%`、可疑 Unicode 分隔或控制字符，以及 `cd` 等会改变目录或再次解释命令的入口，无法可靠确认时都返回 `ask`，即使当前模式是 `full_auto` 或工具已自动批准。已识别的拒绝仍优先。不会从命令文本推算新工作目录，也不会把重定向路径当作已通过文件路径规则。规则只检查 Shell 调用文本，不审查被调用程序或脚本内部的行为。

cmd 和缺少可信解释器信息时只接受共同的无引号简单字面命令，其余要求确认。`TerminalOpen` 的解释器由终端宿主选择，因此始终采用这个保守范围；输入指定 `shell` 时要求确认，不借用前台 Shell 的身份。终端的交互输入流不在本模块的命令文本分析范围内。

模式、规则、工具集合和工作目录由 `PermissionChecker` 实例保存在内存中，可通过 `setMode()`、`addRule()` 等操作调整。配置持久化和用户确认结果由宿主保存。

新增权限判断和模式转换放在本目录，测试放同层 `__test__/`，保持小包结构紧凑。返回[包说明](../README.md)。
