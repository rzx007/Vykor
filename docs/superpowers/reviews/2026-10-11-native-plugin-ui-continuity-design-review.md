# Native Plugin UI 固定位置设计审查记录

> 日期：2026-10-11
> 修订：2026-10-13；下方第 1–3 节是先前审查记录，不代表新的无兼容方案已通过。当前状态见第 4 节。
> 审查对象：[设计文档](../specs/2026-10-11-native-plugin-ui-continuity-design.md)
> 审查方式：独立子代理 `review_ui_design` 只读核对现有代码，主代理修订后再做聚焦复核。
> 本记录是设计审查，不是实现验收；本轮没有改运行代码、运行应用测试或提交代码。

## 1. 审查结论

本轮按用户确认收缩为“每个 UI 组件固定一个位置”，删除读取表单草稿、宿主缓存和位置移动方案。独立子代理只读复核现有 manifest、实例解析、renderer bridge、provider 和 main 挂载规则，发现一项 Important、一项 Minor，无 Critical。

修订后子代理聚焦确认：“两项均已闭合，无剩余阻塞”，可以据此更新计划。该结论只针对设计，不代表实施或测试通过。

本轮首次复核因额度限制中断，在用户要求继续后重试成功；没有将中断当作通过。设计修订与复核完成后才同步实施计划。

上一轮已完成的交接与外观审查仍作为依据；上一轮的双位置捕获/恢复方案已被本轮取代，不能据旧审查记录继续实现它。

## 2. 修订对应关系

| 问题 | 源码依据 | 设计修订 |
| --- | --- | --- |
| Important：不同实例的面板加载仍可能互相顶掉 | main `plugin-ui-service.ts:182` 的共享 sidebar opening slot；现有测试要求保留最新侧栏 | 删除跨实例后一次覆盖规则，保留同实例过期检查；document-store 在写入/撤销前同步检查占用与容量；失败只影响该请求。补并发面板、后一次失败、第三帧竞争验收 |
| Minor：把关闭和重载都写成重新创建 | 初次本轮修订第 6 节关闭/重载表述 | 明确关闭只撤销；重载先撤销再创建；之后重新打开从 snapshot 初始化 |
| 自动替换侧栏、两帧淘汰会丢本地输入 | renderer `plugin-ui-provider.tsx`；main `document-store.ts` | 不捕获表单，改为拒绝新打开并提示先关闭；隐藏的当前面板仍计入两帧限额 |
| mount 撤销后无法查询已接收提交 | main `plugin-ui-service.ts` 的 invalidateOwner/getMount/getAction | 可信宿主请求绑定与网页挂载分开，只读查原 requestId，不重新执行 |
| action 的只读规则不适合交接 | Server `availability/assertActionState`；main 的 snapshot.readOnly | 三个窄来源校验入口；draft 允许无模型/resolved，submit 允许普通 Run 忙碌时排队；原 action 限制不变 |
| 确认期间来源过期、composer 变化 | provider 的确认仅检查来源存在；frame 原 action 确认后再查 revision | prepare 最终文本→确认→复查来源与文本→同步追加最新 scope 文档并去重 |
| SDK 订阅和回执类型含混 | `ui-sdk.ts` 与 bridge 严格 result 解析 | 无草稿创建选项；首次 presentation、订阅回放和 draft/submit 联合回执独立解析 |
| 新交接可能套用 30 秒普通请求超时 | bridge 与 SDK 对 requestAction/dismiss 的确认分类 | requestConversation 加入同一单确认、五分钟确认及 330 秒请求时限 |
| metadata 不是允许字段白名单 | Core `externalToolMetadata` 使用 reserved 过滤 | 改为保留字段过滤，排除 pluginUiSubmission，并要求验证原始输出不能成为受信 Part 字段 |

## 3. 本轮核对通过的边界

- `surfaces` 沿用原字段，但新组件定义严格单项。历史实例保持宽读取；当前定义与摘要不匹配的实例不能重绑。修改位置会改变已有组件摘要，无需新迁移框架。
- 暂时隐藏保留当前 iframe/key，本地表单属于插件；关闭、重载和强制撤销不承诺恢复。宿主不读取表单，也不提供草稿 getter 或缓存。
- 新 SDK 不提供 openSidebar；旧消息仅允许可见有效的固定侧栏挂载聚焦自身，不能移动 inline。现有 bridge 合并的 resize/openSidebar 限制需拆开，resize 的 inline 限制仍保留。
- 插件主动提供 text/data 的会话交接不依赖表单读取，与固定位置互不冲突。
- 外观由 Desktop 提供；不将未提交表单持久化到 PluginUiInstanceRecord，不增加新数据库模型。
- presentation 单独 opt-in，不扩展旧 snapshot，保留旧插件/SDK 严格解析。
- Input、Run、提交回执和实例 resolved 同一事务保存；现有会话事务能够承接，不需要第二套运行系统。
- RunAdmission 的普通用户输入优先规则必须复用；仅调用 dispatchPersistedRun 不会自动取消待运行 Goal continuation。
- daemon 重启中断 pending/running Run 的既有路径适用；不自动重放未知提交。
- composer 必须追加最新文档，不使用 setDraftText 替换整份文档，不触碰已有附件。
- 实例 GET 顶层可选 conversation 字段不进入旧 snapshot/instance；新 main 严格验证两个布尔值，缺失默认关闭。HTTP 组合层不让原实例服务反向依赖交接服务，POST 仍完整复查。

实现时仍须以针对性测试验证上述判断，特别是容量竞争、隐藏与关闭的区别、SQLite 原子性、生命周期竞态、旧 SDK 兼容与真实 Electron 隔离。文档审查不替代这些证据。

## 4. 2026-10-13：无兼容修订，独立复核待完成

用户明确“不做兼容”，本次设计取消第 1–3 节中关于旧协议的安排：

- 组件定义与实例使用单值 surface；不接受 surfaces 数组或字段别名，不保留旧实例宽读取。
- SDK、桥接和宿主彻底移除 openSidebar；不保留旧消息的聚焦行为。
- appearance 与 capabilities 必填进入 snapshot；取消独立 presentation 通道、opt-in、方法缺失 fallback 和旧字段补齐。
- UI schemaVersion / 桥接 version 使用现行 2，daemon pluginUi: 2 精确匹配；只维护当前契约，不自动迁移或删除历史。
- 实例 GET 的 conversation 必填；main 返回业务 snapshot，renderer 用实际外观与可见性组合出完整网页 snapshot，避免 main 读取 CSS 或提供硬编码主题。
- 相同业务 revision 的样式/能力变化仍通知插件，但不重建本地表单；固定位置、隐藏保留、容量拒绝和交接安全规则不变。

子代理两次复核请求均返回“Selected model is at capacity”，没有得到本轮审核意见。当前只有主代理的文档自检，不能记为独立审核通过。此前通过的兼容设计已被用户的新要求取代；无兼容设计完成独立复核并修订后，才能整体重写实施计划。

本次没有修改运行代码，没有运行应用测试，也没有提交或推送。
