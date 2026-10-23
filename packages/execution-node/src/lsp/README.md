# 代码符号与引用查询

提供当前的代码查询入口。LSP 通常指语言服务器协议；本目录目前以文本提取和 ripgrep 实现这些接口。

## 主要文件

- [index.ts](index.ts)：LspClient、配置类型、符号提取和引用搜索。

## 调用与状态

包根公开 `LspClient`、`LspServerConfig` 和结果类型；宿主可通过 `ExecutionRuntimeOwner.withLspClient(config, work)` 让 owner 追踪单次查询和关闭。

`documentSymbols` 读取文件并用规则提取符号；`workspaceSymbolSearch` / `findReferences` 通过 sandbox 的 `createProcess` 运行 rg 并整理结果。`goToDefinition` 当前复用引用搜索，`hover` 返回 null；connect/disconnect 只更新连接标记，不建立真实语言服务器会话。

客户端实例只保存配置及 connected 标记；rg 输出缓冲属于单次调用，取消信号来自配置/owner。没有长期语言服务器进程或符号索引缓存。

## 新增代码与测试

同一职责的新代码放在本目录。本目录目前没有 `__test__/`；新增单模块测试时在本目录创建，跨分类场景放它们共同上层的 `__test__/`。
