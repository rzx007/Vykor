# Client 阶段 5C：基础业务 Resources 实现计划

> **面向 AI 代理的工作者：** 批量迁移全部基础 Resource 后再统一测试。可按 Resource 提交以便回滚，但不逐提交跑全量。

**目标：** 将低耦合基础 endpoint 从 OpenHarnessClient 迁入具体 Resource。

**架构：** 每个 Resource 只接 HttpTransport，拥有路径、query、body 和 decoder。共同变化且方法很少的能力合并，禁止 BaseResource。

**技术栈：** TypeScript、HttpTransport、@openharness/protocol。

---

## 目标文件与方法

- system-resource.ts：commands、settings、context preview/status/usage、memory、profile、dream、output styles。
- provider-resource.ts：providers、models、custom provider、catalog connect/disconnect。
- auth-resource.ts：status/login/logout。
- project-resource.ts：list/inspect/rename/pin/default shell/rebind/archive/init。
- plugin-resource.ts：list/enable/disable/local/archive/git preview/install/uninstall/reload。
- development-resource.ts：skills、agent personas、hooks、git diff/branch/status/commit。
- resources/index.ts。

## 批量实现

- [ ] 从 http-client.ts 生成方法—endpoint—decoder 表，逐项打勾。
- [ ] 每个 Resource 构造 constructor(private transport: HttpTransport)。
- [ ] 原样迁移 encodeURIComponent、URLSearchParams、省略 undefined、body shape 和 signal。
- [ ] decoder 留在业务 Resource；通用 responseField/array 从 transport helper 复用。
- [ ] Memory/Profile/Dream 若依赖完全相同放 SystemResource，不为单方法建类。
- [ ] Plugin archive/git 的 preview/install 不合并成万能 install。
- [ ] Git commit 的 patch/message/body 和错误保持。
- [ ] OpenHarnessClient 构造并公开 system/providers/auth/projects/plugins/development。
- [ ] 旧平铺方法一行转发，删除 path/body/decode。
- [ ] 更新 resources/index.ts 和顶层类型导出，不删除旧 export。
- [ ] 快检 Client 类型。
- [ ] 按 2–3 个逻辑提交：system/provider/auth/project；plugin；development。
- [ ] 最终确认 http-client.ts 不再出现这些 endpoint 字符串。

## 统一测试清单

为每个 Resource 至少覆盖：method/path/query/body/signal、成功 decoder、非2xx透传、特殊字符编码。复用记录 fetch fixture，不 mock Resource 内部方法。

## 审核重点

无 BaseResource；无 endpoint 丢失；Resource 不导入 OpenHarnessClient；旧方法仅转发；公开类型不破坏。
