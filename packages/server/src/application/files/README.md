# 会话工作区文件

提供会话工作区的只读文件访问。工作目录与权限由服务端会话确定，调用方只传工作区相对路径。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| [session-file-service.ts](./session-file-service.ts) | `SessionFileService` 从会话取目录与配置，管理操作许可、环境、读取和搜索预算。 |
| [file-access.ts](./file-access.ts) | `createSessionFileAccess` 检查相对路径、工作区真实边界、工具权限与 sandbox 读取规则。 |
| [__test__/file-access.test.ts](./__test__/file-access.test.ts) | 真实临时目录、链接、拒绝规则、取消和 WSL 映射测试。 |

服务入口为 `application.files`，HTTP 适配见 [session-files.ts](../../http/routes/session-files.ts)。服务先检查就绪与会话，同步取得 operationGate 共享操作许可（避免读取与工作区重绑定、维护或关闭交错），再读取 `sessionSettingsRoot` 对应配置并取得环境；工具上限与拒绝合并会话 runtime 配置。CLI advanced 使用本机环境，Desktop 使用已有 local/WSL 工厂，文件访问不加载 Agent 专用机密变量。请求结束先释放环境，再释放许可，不创建 Agent、审批或持久事件。

`list/stat/readText/find/search` 只调用环境文件接口。搜索先逐项授权再读取，用已有 glob 规则和单行字面文本匹配，不解析工具展示字符串。每文件最多256KiB、总读取8MiB、最多4000目录项、最长10秒；包含二进制的读取也计费。截断、取消与文件错误通过结果或稳定错误码交给调用方。正文使用真实目标路径；元数据使用已授权的原路径，保留链接类型；递归不进入目录链接。

## 调用入口与步骤

调用 `createSessionFileAccess(environment, settings)` 后，逐个向 `authorize(path, tool, signal)` 传入目录或文件路径。它先拒绝非法路径，执行工具权限和明确的读取拒绝，再由实际执行环境解析真实路径，检查目标仍在工作区，并重新执行权限与读取规则。返回值保留请求的相对路径；正文读取使用 `executionPath` 的绝对真实路径，`sourcePath` 只供应用服务检查原路径的链接类型。

WSL 的 POSIX 路径在 WSL 内验证。Windows 绝对规则只在路径能够双向映射时按 Windows 规则检查；不能可靠映射或混用 Windows 与 POSIX 绝对权限规则时返回 `file_not_supported`。批准结果为 `ask` 时直接拒绝，不创建审批。

允许工具列表沿用 Agent 的名称规范化：`*` 表示不限制；明确列出的工具构成调用上限，不能被自动批准或路径允许规则放宽。

## 状态归属

检查器实例只缓存本次访问的工作区真实根目录。规则中的链接每次重新解析，不保存授权结果或写入会话状态；环境释放由调用它的应用服务负责。

## 新增代码与测试

访问检查放在本目录，与底层文件 adapter 分开。测试放在 [`__test__/`](./__test__)；扩展检查时覆盖同一规则通过不同路径别名访问的情况。
