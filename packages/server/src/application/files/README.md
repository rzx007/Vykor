# 会话工作区文件

提供会话工作区的只读文件访问。工作目录与权限由服务端会话确定，调用方只传工作区相对路径。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| [session-file-service.ts](./session-file-service.ts) | `SessionFileService` 从会话取目录与配置，管理操作许可、环境、读取和搜索预算。 |
| [file-access.ts](./file-access.ts) | `createSessionFileAccess` 检查相对路径、工作区真实边界、工具权限与 sandbox 读取规则。 |
| [__test__/file-access.test.ts](./__test__/file-access.test.ts) | 真实临时目录、链接、拒绝规则、取消和 WSL 映射测试。 |
| [__test__/opened-file-access.test.ts](./__test__/opened-file-access.test.ts) | 文件打开后重新授权、路径替换、同句柄有界读取、关闭与缺少安全能力的回归。 |
| [__test__/session-file-service-entry-search.test.ts](./__test__/session-file-service-entry-search.test.ts) | 特殊枚举项跳过、用户非法路径与权限边界、Unicode 字面匹配摘要回归。 |
| [__test__/session-file-service-scan.test.ts](./__test__/session-file-service-scan.test.ts) | 有界目录扫描、累计候选预算、截断与不支持环境的回归。 |

服务入口为 `application.files`，HTTP 适配见 [session-files.ts](../../http/routes/session-files.ts)。服务先检查就绪与会话，同步取得 operationGate 共享操作许可（避免读取与工作区重绑定、维护或关闭交错），再读取 `sessionSettingsRoot` 对应配置并取得环境；工具上限与拒绝合并会话 runtime 配置。CLI advanced 使用本机环境，Desktop 使用已有 local/WSL 工厂，文件访问不加载 Agent 专用机密变量。请求结束先释放环境，再释放许可，不创建 Agent、审批或持久事件。

`list/stat/readText/find/search` 只调用环境文件接口。搜索先逐项授权再读取，用已有 glob 规则和单行字面文本匹配，不解析工具展示字符串。忽略大小写时先匹配，再把命中位置映回原文，避免 `İ` 等转换后长度变化的字符使摘要丢失匹配。内容搜索每文件最多 256 KiB、总读取 8 MiB、最长 10 秒；包含二进制的读取也计费。截断、取消与文件错误通过结果或稳定错误码交给调用方。元数据使用已授权的原路径，保留链接类型；递归不进入目录链接。接口保持只读，不提供写入或分页。

目录列举及递归查找、搜索通过 `scanDirectory` 逐项采集，单次请求最多 4000 个候选目录项，包含截断探针，底层提前停止，不先读取完整目录。目录排序只针对已采集的受限集合，大目录结果不保证是全目录排序后的前若干项。被拒绝或 API 无法表示的枚举项会跳过，其余项继续处理；比如 POSIX 合法的 `a\b.txt` 无法用公开路径格式表示。用户直接传入这类路径仍返回 `file_invalid_request`（400）。缺少有界扫描能力时返回 `file_not_supported`（501），不回落到无界 `listDir`。

## 调用入口与步骤

调用 `createSessionFileAccess(environment, settings)` 后，逐个向 `authorize(path, tool, signal)` 传入目录或文件路径。它先拒绝非法路径，执行工具权限和明确的读取拒绝，再由实际执行环境解析真实路径，检查目标仍在工作区，并重新执行权限与读取规则。返回值保留请求的相对路径；`sourcePath` 只供应用服务检查原路径的链接类型。

正文读取通过 `openRead(executionPath, signal)` 打开文件，取得同一文件对象的真实路径、元数据与句柄（指向已打开对象的引用）。服务用 `verifyOpened(canonicalPath, tool, signal)` 重新检查工作区、工具和读取规则，随后从该句柄单次有界读取，在 `finally` 中关闭。后续路径替换不能让正文读取转向另一个对象；缺少安全打开能力时返回 501，不回退为按路径重新打开或读取。

WSL 的 POSIX 路径在 WSL 内验证。Windows 绝对规则只在路径能够双向映射时按 Windows 规则检查；不能可靠映射或混用 Windows 与 POSIX 绝对权限规则时返回 `file_not_supported`。批准结果为 `ask` 时直接拒绝，不创建审批。

正文读取在 Linux/WSL 需要 `/proc` 来核验已打开对象；WSL 的目录扫描还需要 Bash 与 GNU coreutils 9+。Windows 本机正文读取当前只支持本地 NTFS 且只有一个硬链接名称的文件，使用 PowerShell 与 `fsutil` 做只读核验，可由普通账号执行。其他 Windows 卷、UNC 路径和 macOS 暂不支持安全正文读取，返回 501；所需命令或系统能力不可用时也按不支持处理。`stat` 等元数据操作与正文读取的支持范围分别判断。

允许工具列表沿用 Agent 的名称规范化：`*` 表示不限制；明确列出的工具构成调用上限，不能被自动批准或路径允许规则放宽。

## 状态归属

检查器实例只缓存本次访问的工作区真实根目录。规则中的链接每次重新解析，不保存授权结果或写入会话状态；环境释放由调用它的应用服务负责。

## 新增代码与测试

访问检查放在本目录，与底层文件 adapter 分开。测试放在 [`__test__/`](./__test__)；扩展检查时覆盖同一规则通过不同路径别名访问的情况。
