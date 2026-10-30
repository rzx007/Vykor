# 会话只读文件 API 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 @rzx/client 提供会话绑定的只读目录、信息、文本与搜索接口。
**Architecture:** domain-contracts/files 纯数据契约，Protocol 转导出并检查响应 -> daemon SessionFileService 授权/会话环境 -> 现有环境文件 adapter；SDK FilesResource 只发送请求。各请求拥有操作许可并在 finally 释放。
**Tech Stack:** TypeScript、Hono、Vitest、pnpm、既有 environment/permissions/sandbox。
**Spec:** docs/superpowers/specs/2026-10-30-session-files-design.md

## Global Constraints

- 默认连接已有 daemon；不增加写入、Agent 初始化、模型调用或持久化状态。
- 工作目录完全由会话决定；候选路径与真实路径均限定工作区，逐个执行读取权限。
- 不复制文件系统后端；local/WSL adapter 兼容扩展；搜索为字面文本并受预算约束。
- 保留 docs/client-sdk.md 当前未提交修改；测试放所属 __test__，分类维护 README。

## Task 1: 环境文件信息与有界读取

Files: packages/environment/src/types.ts、packages/tools/src/file/operations.ts 及所属测试/说明。
Interfaces: EnvironmentFileStat 可选 sizeBytes/modifiedAt；readBytes(path,{maxBytes?,signal?}) 返回不超过 maxBytes 字节，未传选项保持旧行为。
- [x] 用临时真实文件验证原 stat 缺失信息、有界读取未生效及预取消失败。
- [x] 实现 Host 与 WSL 元数据、有界读取和取消；固定脚本参数传路径，保证关闭文件句柄。
- [x] 运行相关 Host/WSL 测试与类型检查。

## Task 2: Protocol 与 SDK

Files: packages/domain-contracts/src/files/、packages/protocol/src/files/{session-files.ts,__test__,README.md}、Protocol root、packages/client/src/resources/files、types/root/class、私有 facade。
Interfaces: Spec 中五个方法、查询和结果类型；SessionFileError 及稳定 code；8个客户端资源。
- [x] 对请求解析/上限/未知参数与 SDK 缺少 files 资源先观察 RED。
- [x] 实现纯数据解析与 FilesResource，GET 路径使用 transport.path，signal 不进入 query。
- [x] SDK 根只导出所需类型和 FilesResource；私有 facade 复用公开 FilesResource。
- [x] 运行 Protocol/SDK/私有层相关测试及类型检查。

## Task 3: 会话授权与文件应用服务

Files: packages/server/src/application/files/{file-access.ts,session-file-service.ts,__test__,README.md}、runtime/session-execution-environment.ts、DaemonApplication。
Interfaces: createSessionFileAccess(environment,settings) -> authorize(relativePath,Read|Glob|Grep,signal?)；SessionFileService 五个方法与 SDK 对应。
- [x] 真实临时工作区/假WSL句柄测试先验证缺少服务、越界/deny/read-only 规则和资源释放。
- [x] 实现 canonical workspace + PermissionChecker + sandbox policy 共用授权；不将 POSIX 路径交给 Windows host validator。
- [x] 服务从持久会话/配置取得环境；遍历与搜索只读取已授权候选，使用有界 readBytes 和字面文本匹配，返回截断标记。
- [x] 同步接入 operationGate 与 ready 状态，成功/取消/失败均释放。
- [x] 运行服务/权限单元测试与服务端类型检查。

## Task 4: HTTP、安装包与文档验收

Files: server/http/routes/session-files.ts 与测试、http/server.ts/system.ts、SDK contract、public consumer、verify-pack、各层文档。
- [x] HTTP 鉴权/协议/session root 真实联调先 RED，再接五个GET端点并声明 sessionFiles:1 能力。
- [x] 更新公开 API 契约、资源集合及 NodeNext/Bundler/browser 消费用例，验证没有写入入口。
- [x] 补文档示例、预算、路径语义、错误与兼容说明；保留既有文档调整。
- [x] 运行 SDK/Protocol/server 受影响测试、相关类型、test:pack、架构/retired/docs 检查。
- [x] 独立复核变更，修复发现后保存到当前隔离分支，不发布 npm。
