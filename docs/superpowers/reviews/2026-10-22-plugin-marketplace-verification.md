# 插件市场验收记录

日期：2026-10-22。

## 交付范围

- 官方发布仓库：[rzx007/vykor-plugins](https://github.com/rzx007/vykor-plugins)，提交 `5062942`。
- [公开目录](https://rzx007.github.io/vykor-plugins/marketplace.json)及 Excalidraw 1.0.0、Text Inspector 1.2.2、Notes 1.0.2 三个不可变 Release 已上线。
- 宿主实现位于隔离工作区 `C:/Users/ruanz/.codex/worktrees/plugin-marketplace/OpenHarness-ts`，分支 `codex/plugin-marketplace`。插件许可证提交 `31698bb3` 已作为固定发布源码推送该分支；市场宿主改动保留在本地，没有合并或推送主分支。
- 主工作区原有的 Agent/Protocol 改动没有被本轮覆盖、重置或带入发布源码提交。

## 定向验证

| 验证范围 | 结果 |
| --- | --- |
| 发布仓库校验与构建隔离回归 | 8 项通过；完整发布 CI 通过 |
| 上游三个插件构建和测试 | 49 项通过；Excalidraw 类型检查通过 |
| 市场数据契约 | 9 项通过 |
| 来源、下载、原 ZIP/Git 解析和独立安装包 | 67 项通过 |
| Installer 与安装存储 | 16 项通过 |
| Server 市场安装、原安装服务、路由与 daemon | 53 项通过 |
| Desktop 市场 Main/IPC/UI，以及面板草稿和控制器 | 28 项通过 |
| 原 Desktop PluginManager 与 Main PluginService | 69 项通过 |
| Client 市场传输 | 1 项通过 |
| plugin-contracts、plugin-sources、plugins、server、client 类型检查 | 通过；同时完成新工作区的 agent-runtime 声明构建 |
| 文档检查及 diff 空白检查 | 通过 |

宿主定向测试合计 243 项。按改动范围统一验证，没有重复运行完整测试套件或新增界面截图/预览。

线上验证使用临时目录和独立安装记录，通过宿主实际来源、下载和 Installer 代码安装了三个插件，全部返回 `installed`。该验证检查了实际 HTTPS 跳转、ZIP 大小与摘要、Native 清单、权限及安装回执；未写入用户插件目录。发布仓库另行下载并核对三个线上 ZIP，全部与市场目录一致。

## 审查修复

1. 发布构建不再复用跨次运行的脏检出，改为每次创建临时检出，同次构建内复用；清理前验证目录范围。回归先复现旧文件混入问题，再验证两次构建字节一致。发布 CI 重用了原不可变资产，没有覆盖已发布 ZIP。
2. 已安装本地插件或其他来源插件可以进入关联/换源确认，不再被“已安装”按钮挡住。同源同版本仍显示已安装。
3. 安装在排队或复制期间被取消、来源停用或预览到期时，原 Installer 在提交安装记录和回执前再次检查。回归持有安装锁、提交请求、停用来源再释放锁，确认没有发布新安装。
4. 无提示复用权限不会重新授予已撤销权限；同一操作 ID 不能绑定另一份并发请求；同一候选包不能并发执行多次。

发布仓库审查问题及宿主两项 P2 均经独立复审关闭，限定范围无剩余 P1/P2。

## 类型检查的现有基线问题

完整 Desktop Node/Web 类型检查仍然非零；以下位置未由市场实现修改，报告没有把它们算作通过：

- `apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts:670`：测试仍使用已移除的 `HookExecutor.register`。
- `apps/desktop/src/main/features/session/tool-summary-files.test.ts:13`、`:53`：旧 `StreamEvent` 导入和 `HookExecutor.register`。
- `packages/server/src/application/session/plugin-app-assembly.ts:294`：Desktop Node 编译配置下的资源结果联合类型不匹配。
- `packages/agent-contracts/src/children.ts`、`errors.ts`、`execution.ts` 和 `packages/protocol/src/requests.ts`、`scheduled.ts`：Desktop Web 编译配置将现有未使用符号判为错误。

因此没有声称完整桌面生产构建通过，也没有发布新版桌面安装器。本轮受影响包及市场自身类型已通过，完整桌面构建需要先消除这些基线错误。

## 使用边界

更新不关闭会话或重载现有面板，切换、收起和会话切换草稿回归通过。草稿跨进程退出的原有限制保持不变。自定义源使用公开 HTTPS 解析地址；内置固定 GitHub 来源兼容本机 TUN 代理的 `198.18/15` 映射，仍执行证书、主机名、回环与私网检查。

外观按照仓库约定留给用户实际体验反馈，没有做截图验收。
