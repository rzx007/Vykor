# Stage 7D：Desktop Main 消费者迁移实施计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans。按功能目录批量迁移并核对 AST 明细；类型检查和测试统一留到 7F。

**目标：** Electron 主进程的服务、IPC 和后台任务只通过命名 Resource/Protocol 使用 Client，同时保持窗口、IPC、重试和持久化行为不变。

---

## 固定审计矩阵

| 功能 | 目标能力 |
|---|---|
| settings | `protocol`、`system` |
| attachment service / IPC | `attachments`、`protocol` |
| provider | `providers`、`auth`、`system` |
| plugin | `plugins` |
| skill | `development` |
| schedule | `schedules` |
| terminal | `terminals` |
| session service / operations / subscription | `protocol`、`system`、`sessions`、`projects`、`permissions`、`events`、`jobs` |

实际路径以仓库现状和 7A AST 报告为准，不因表中未列出就忽略扫描结果。

## 任务 1：生成逐文件清单

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/desktop/src`。
- [ ] 按上述功能矩阵归类每条调用，并记录旧入口到新入口映射。
- [ ] 区分 main/preload/renderer；本波主要改 main，但扫描结果中的生产旧调用都必须有明确去向。
- [ ] 标记 Client 创建、连接刷新和订阅生命周期边界，这些位置允许完整 Client；业务服务参数应收窄。

## 任务 2：迁移服务与 IPC

- [ ] settings 中健康/能力使用 `protocol`，设置读写使用 `system`。
- [ ] attachment 中上传、读取、删除使用 `attachments`；协议能力检查使用 `protocol`。
- [ ] provider 登录/凭据使用 `auth`，供应商与模型使用 `providers`，全局设置使用 `system`。
- [ ] plugin、skill、schedule、terminal 分别迁移到表中对应 Resource。
- [ ] session 的状态/操作、项目、权限、事件和后台 job 各归入对应 Resource，不建立新的聚合 service facade。
- [ ] IPC channel 名、payload、返回值、错误码和 cancellation/abort 传递保持不变。
- [ ] 订阅对象的创建/销毁顺序、重连策略和 cursor 语义保持不变。

## 任务 3：收窄依赖类型

- [ ] 业务模块用小型 capability interface 或 `Pick<Resource, ...>` 表达真实依赖。
- [ ] 将 `OpenHarnessClient["previewPluginArchive"]`、`OpenHarnessClient["previewPluginGit"]` 等兼容方法类型索引改为对应 Resource 方法类型，不能只迁移运行时调用。
- [ ] 不把 transport、token 或 Client 全对象传进只需一个 Resource 的纯业务函数。
- [ ] Client owner/connection manager 可保留完整 Client，避免复制生命周期管理。
- [ ] 不新增容器、注册表或第二套依赖注入框架。

## 任务 4：迁移测试

- [ ] 将 service/IPC mock 改为命名 Resource 结构。
- [ ] 保留 IPC 契约、错误映射、重试、取消、订阅释放和持久化断言。
- [ ] 针对功能矩阵每行至少有现有测试覆盖；若现有测试缺口会让本次迁移无法验证，仅补最小回归测试。
- [ ] 禁止通过宽泛 cast 或 `any` 恢复旧形状。

## 任务 5：静态清单核对与提交

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/desktop/src`，预期调用和成员引用均为 0。
- [ ] 本波不运行 Desktop typecheck/test 或根门禁；统一留到 7F，提交说明注明“尚未统一验证”。
- [ ] 更新 baseline 和迁移状态，只记录实测值。

```bash
git add apps/desktop/src scripts/architecture-baseline.json docs/architecture-migration-status.md
git commit -m "refactor(desktop): use named client resources"
```

## 验收标准

- Desktop 生产旧调用和旧成员引用为 0；
- IPC 契约、订阅生命周期、cursor 和重试行为不变；
- 业务服务依赖已收窄，Client owner 仍负责连接生命周期；
- 完整类型、测试和架构门禁结果由 7F 给出。
