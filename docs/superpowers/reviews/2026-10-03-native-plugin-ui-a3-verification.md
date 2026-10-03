# Native Plugin UI A3 验证记录

> 状态：A3 Task1–6 已实现，桌面接入和运行安全检查已通过；A4 正式参考插件、Converter 交付和用户人工验收不在此计划内。本记录不是“整个首版已发布”的声明。
> 日期：2026-10-03；分支 `codex/plugin-ui-a1`；计划基线 `c3b3d411`。

## 已实现范围

Task 1 提供严格浏览器消息契约和 `@vykor/plugins/ui-sdk`：父窗口一次初始化、真实 MessagePort、不可变参数、快照防回退、pending / 超时 / dispose 清理。请求和快照以有界 JSON 文本传输，先检查 UTF-8 大小，再解析；data / args 的20层限制不把消息封装层误计进去。只开放规格的五个方法，不把 Session ID、原始结果或工具表放进 iframe 快照。

Task 2 提供按窗口和实际 frame 身份登记的一次性内存文档、专用 scheme、响应 CSP / 权限策略、导航和窗口清理。main 启动与主窗口已接线；preload 明确只暴露给 mainFrame，主 CSP 仅增加 frame-src。

Task 4 增加可信源工具独立卡片、按点击加载、受限 iframe、有限 MessagePort 桥接、宿主确认和现有工具面板的具体实例侧栏。保留原始文字，失败可重载；关闭显示只 unmount。确认冻结参数/版本/请求 UUID；提交超时查同一请求、不重新提交。已有会话更新推动快照，源删除、断线、会话改变和主进程撤销会关闭页面/确认；同窗口最多两个显示、一个侧栏，同实例搬移时销毁原 frame。主题和语言读取实际宿主，不新建轮询或连接。

## 实测命令

Task 3 增加有限、类型化的 main IPC / preload、可信主窗口校验、实际 Client / 主会话归属和异步代次复验；文档只返回 URL。连接刷新、会话切换和窗口销毁会撤销挂载。动作使用原请求 ID，经 A2 调用；关闭显示不取消业务，宿主 dismiss 不要求 iframe。38 项聚焦测试通过（service8、IPC1、preload11、connection8、subscription10），Desktop node/web 类型均 exit0。两项订阅测试首次因 Electron 包没有默认安装路径在收集阶段失败，设置现有缓存的 ELECTRON_OVERRIDE_DIST_PATH 后10项全部通过；未修改依赖或下载运行时。

所有 pnpm 命令使用 `pnpm --config.manage-package-manager-versions=false`，在隔离 worktree 使用现有本地依赖；没有安装新包、下载浏览器、请求真实模型或修改用户 daemon registry。

| 范围 | 命令（省略共同前缀） | 结果 |
| --- | --- | --- |
| Protocol | `--filter @vykor/protocol exec vitest run src/plugin-ui-bridge.test.ts src/plugin-ui.test.ts src/plugin-ui-requests.test.ts` | 122 passed /0 failed，其中 bridge13 |
| SDK | `--filter @vykor/plugins exec vitest run src/ui-sdk.test.ts` | 8 passed /0 failed，真实 Node MessageChannel 配合 test-only Window 事件入口 |
| 类型 | Protocol、Client、Plugins 的 `check-types` | 全部 exit0；Plugins 增加独立 DOM SDK 类型检查 |
| 公共 API | `check:client-api` | tsc exit0，Node31/31、Client4/4 |
| SDK 浏览器 | `exec vite build --config tests/browser-plugin-ui-sdk/vite.config.ts` | exit0，26 modules、10.66 kB；Node builtin / browser-external 会使构建失败 |
| Desktop 单元 | `--filter @vykor/desktop exec vitest run src/main/features/plugin-ui/document-store.test.ts src/main/features/plugin-ui/window-policy.test.ts src/preload/desktop-api.test.ts src/main/features/main-window/webview-policy.test.ts` | 24 passed /0 failed，document10、policy1、preload11、原 webview2 |
| Desktop 类型 | `--filter @vykor/desktop typecheck` | node / web 均 exit0 |
| 真实 Electron | `--filter @vykor/desktop test:plugin-ui-electron` | 实际39.8.10，JSON result=passed、electronExitCode=0；requests/popups/downloads 均为0 |

## 真实 Electron 证明了什么

使用已缓存的 Electron39.8.10 x64，解包到本计划忽略目录；窗口 show=false、进程 windowsHide。独立测试 profile、日志与临时后台服务，不启动正常主应用、托盘、更新器或用户 daemon 连接。

测试构建生产文档 store / protocol / window-policy 和实际 preload，运行实际浏览器 SDK。可信主窗口确有 desktop API，插件 frame 则 require / process / Buffer / desktop / electron 均 undefined，父 DOM 不可访问。SDK 经真实浏览器 MessageChannel 取得快照并更新页面。

作者页面自己的事件处理器尝试 fetch、外部图片、弹窗和 data URL 下载，测试服务实际接收请求为0、弹窗和下载为0。作者导航到同窗口另一个已登记实例时，实际导航策略阻止加载，另一个实例内容未执行。错误窗口使用实际子 frame 读取检查，未取得文档；不能只用 parent.contentDocument=null 证明，因为 opaque iframe 即使成功加载也会返回 null。撤销后内存响应404，退休 frame 不能执行新的页面内容。主页面追加内联脚本也未执行。

探测确认初始请求与加载完成后的 renderer process / routing ID 会变化，而 frameTreeNodeId 保持相同；代码使用后者绑定，不依赖临时进程编号。窗口销毁清理保存原 Session 引用，避免在 destroyed 后访问 contents.session 而失败。

测试里的故意 data 导航会触发 Electron39.8.10 固定的 Chromium opaque-origin 检查及 ERR_BLOCKED_BY_CSP 诊断。runner 仅识别这些精确固定夹具消息，其余 stderr 原样显示并使测试失败；这次精确匹配8行。没有用此 test-only 捕获去修改或吞掉生产诊断，也不宣称任意插件日志已经通用脱敏。

Electron 可能把拒绝导航的 URL 留在错误页状态。是否有外部内容执行、实际网络/文件副作用和权限变化才是隔离断言；不把“URL字符串必须保持不变”作为所有拒绝情况的证据。上述真实测试仍检查有效文档内容、其他挂载拒绝与实际请求计数。

## 失败到通过的记录

- Protocol / SDK 新模块缺失先失败；随后枚举类型反例证明数组不能被 String 转换后假装合法字符串（1 failed），修正后 bridge13全过。
- 文档模块缺失先失败；实现后10个真实 Request/Response、字节摘要和撤销测试通过。
- 一处空对象测试夹具错误已修正；Electron CJS入口扩展名、测试跨进程 undefined→null 返回表示和主进程注入攻击的权限差异也已核对，均不冒充产品缺陷。
- 原窗口销毁清理访问已销毁 contents 的 Session 导致退出失败；保存原 Session 后，退出码和清理断言通过。

## 前期界面验证

第二批实测：renderer 聚焦85项通过，含新 UI17项以及消息模型28、原工具详情20、面板16、会话合并4；包括仅侧栏组件不能显示无效卡片入口，以及实际 UtilityPanel 具体实例打开/关闭且不 dismiss 的回归。Desktop node/web 类型均 exit0；378篇文档检查和 whitespace 通过。既有面板测试仍有 jsdom canvas getContext 提示，7项通过，没有增加 canvas 依赖或隐藏提示。无效消息计入滚动限流、仅侧栏组件无效入口的测试均先失败，修复后通过；确认框始终在 iframe 外，取消/源删除不提交，确认后一次提交、旧 revision 不自动替换、超时查询原请求有真实 MessageChannel 测试。

扩展隐藏 Electron39.8.10 runner，构建生产 Card / Provider / Frame / 确认框 / bridge、实际 preload / 有限 main IPC / DesktopPluginUiService / VykorClient，以及实际浏览器 SDK。测试后台是手写 fetch 夹具，不是 Native Runtime / SQLite。实测打开→SDK 请求→宿主确认→取消零提交→再次确认一次提交→现有 sessionUpdated 入口刷新 data→关闭显示不再次提交；actionAdmissions=1、electronExitCode=0。原隔离检查仍通过，requests/popups/downloads=0，8行精确预期 Chromium 诊断，没有放宽 stderr 判断。

视觉沿用现有 PRODUCT.md / DESIGN.md、AlertDialog / Button 和语义颜色，无新增依赖或样式系统。对1440宽浅色和390宽深色各检查卡片/确认框，4张实际图片保存在本计划忽略目录 ui-captures；已逐张查看，无横向溢出。首次截图被隐藏窗口的动画/绘制节流影响，不当作验收证据；关闭测试窗口的背景节流、仅测试截图禁用动效并等待两帧和确认框 opacity=1 后重新捕获。一次机械 UI 检查返回空问题列表。按用户顺序执行约定，本批仅在当前会话检查新增 UI，整体独立安全审查留在 Task6，不重复派遣逐任务审查；没有重写 DESIGN.md。

## 最终生命周期与真实执行证据

Task5 使用统一的临时禁止范围，在首次等待之前阻止相关 UI 新准入；取消精确 UI Run 并等结算，再走原有管理互斥检查。普通模型工作不取消，仍按原规则返回409。失败也释放禁止范围。插件重载、禁用、卸载、安装/重装、普通配置与命名配置更新、会话 pluginsEnabled 变更，以及对话 PluginInstall 工具均接线。会话能力变更在 cwd 范围内另按 sessionId 收窄，避免取消同目录其他会话。

不新增表：已有 session.updated 携带可选 metadata.pluginUiGeneration；桌面主进程在合并显示更新之前观察该字段、来源删除和重连，撤销文档及旧调用绑定。HTML 读取结束后再次核验后台代次，不能依赖 SSE 一定及时。Source Part 的业务 status/revision 不因“只撤销显示”而改变。后台完整接线后公布可选 features.pluginUiLifecycle=1；旧后台仍回退到原文字。新增可选 plugins.uiEnabled（默认 true）只关闭 UI，不关闭普通插件工具。

后台实测42项：真实 Native/SQLite UI HTTP32、真实安装生命周期6、PluginInstall4；另受影响的会话修改/维护保护/设置/路由/UI 服务和执行回归166项全部通过。真实权限等待取消为 not_started/零副作用，已调用 Native 后取消为 unknown/不重放；普通模型继续运行；失败维护不留下永久禁止范围。Server 类型检查通过；已重建修改后的 Agent Runtime。

最终 Electron39.8.10 同时运行实际生产 store/protocol/policy、preload、有限 IPC、main service、会话订阅、React 卡片/确认/bridge 和浏览器 SDK。单独 Node 进程运行真实 Daemon、SQLite 和安装后的 Native 插件，模型输出完全本地固定，不调用外部模型。两个登记窗口共享同一实例：取消前后执行数0，两次旧版本确认只有一次 Native 文件写入，另一窗口冲突；两窗经现有 SSE 收到 data=0。UI 不增加 Input 或模型 Attempt。关闭显示不取消业务；禁用插件关闭两窗页面和待确认操作，执行数仍1。

作者世界的实际攻击尝试涵盖父 DOM/Node/preload、文件读取、fetch/图片、外部脚本和字体、meta CSP 放宽、worker、嵌套 iframe、导航、弹窗、下载；实际外部服务收到请求0、弹窗0、下载0。实际浏览器 MessagePort 的未知方法、额外字段和旧 mount 被拒绝，没有 Native 副作用。真实返回JSON：nativeExecutions=1、realSqlite=true、dualWindowRevisionConflict=true、revokedConfirmation=true、electronExitCode=0。

Windows 子进程启动器修正了 --import 文件 URL、模块扩展名和依赖所属目录；启动分段有45秒上限，退出有5秒兜底。审计日志逐条解析并核对字段、插件/工具/会话/cwd、摘要和状态，断言无 token/原始参数；仅允许精确 Node punycode/SQLite 提示和原8行 Chromium 诊断，未知 stderr 仍失败。测试等待真实 iframe/SDK、异步 IPC 排空，不用增加业务重试或重放动作。

完整 Desktop build（含 node/web 类型与工作区依赖检查）exit0，未打包/发布。构建仍有原有动态/静态混合导入和路由测试文件提示。并行构建时旧 Write 订阅测试一次超时，单工作进程单独重跑通过；新生命周期观察测试最初漏保留夹具的 desktop.workspaceMode，修正夹具后通过，未改生产行为来迎合测试。

最终保存前检查：Desktop受影响12个文件83项全部通过（单worker），其中包含管理页22、桥接/卡片17、文档/归属/策略/撤销26、订阅11和面板7；Node/Web类型再次exit0。Server受影响42+166=208项通过，合计本次291项聚焦检查；没有把先前未修改的全仓测试重复计入。文档378篇与whitespace通过。管理详情的过期“未接入”提示已改为实际入口说明，仍不将静态数量宣传为正在运行。分支和隔离工作区保留，不执行合并或发布。

## 一次独立审查及修复

按计划仅调用 a3_final_security 一次，不重复 A1/A2 审查。发现1个 P2：revokeOwner 在会话/代次撤销时过早清除了实际 frame 的隔离记录。已用失败回归复现并修复为“撤销文档不清实际 frame；确认 DOM/frame 消失或窗口销毁后才清”。真实 Electron 退休攻击也改为 owner 撤销；不声称曾证明外部数据泄露，因为父 CSP 同样限制目标。所检查的其余 A3 路径未发现可确认的 P1/P2；没有重新派遣逐项审查。

## 验收映射与边界

| 项目 | 证据 |
| --- | --- |
| UI-17 SDK | DOM 类型、26模块无 Node 浏览器构建、SDK真实 MessageChannel、Electron实际 SDK |
| UI-18 文档归属 | main service12、一次性文档11、物理 frame/窗口与后台代次复验 |
| UI-19 隔离 | Electron作者世界攻击及真实网络/窗口/文件读取结果；真实退休 frame 拦截 |
| UI-20 有限操作 | IPC mainFrame 校验、严格协议/限流、实际 Port 反例、宿主确认与 Native 计数 |
| UI-21 生命周期 | Native/SQLite管理交错、普通模型不取消、既有SSE主进程早期观察、gen/Source/Client失效测试 |
| UI-22 原文字/回退 | 卡片失败/旧能力回归、禁用后原始结果仍在、普通插件工具不受 UI 开关影响 |
| UI-23 快照/迟到 | cursor/revision 合并、HTML后查gen、旧窗口/连接回复拒绝、双窗口真实 SSE 一致 |

不同平台的 Electron 行为未实测；UtilityPanel 标签的新行为有 jsdom 回归，截图使用最小测试页面而非完整正常应用。没有用户本人参与的人工键盘/焦点体验验收，没有正式 A4 参考插件或 UI-24–UI-26 首版交付声明。不合并、不推送、不发布；测试 profile、数据库和截图仅在本计划忽略目录保留。
