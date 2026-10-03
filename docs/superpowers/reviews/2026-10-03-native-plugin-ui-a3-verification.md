# Native Plugin UI A3 验证记录

> 状态：SDK、文档隔离和 Task 3 后台入口已实现；Task 4–6 尚未完成，不是完整 A3 或首版发布验收。
> 日期：2026-10-03；分支 `codex/plugin-ui-a1`；计划基线 `c3b3d411`。

## 已实现范围

Task 1 提供严格浏览器消息契约和 `@vykor/plugins/ui-sdk`：父窗口一次初始化、真实 MessagePort、不可变参数、快照防回退、pending / 超时 / dispose 清理。请求和快照以有界 JSON 文本传输，先检查 UTF-8 大小，再解析；data / args 的20层限制不把消息封装层误计进去。只开放规格的五个方法，不把 Session ID、原始结果或工具表放进 iframe 快照。

Task 2 提供按窗口和实际 frame 身份登记的一次性内存文档、专用 scheme、响应 CSP / 权限策略、导航和窗口清理。main 启动与主窗口已接线；preload 明确只暴露给 mainFrame，主 CSP 仅增加 frame-src。尚无 renderer 插件交互入口或 main 后台动作 IPC，不能据此说用户已能使用卡片/侧栏。

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

## 尚未验证与下一批

UI-17 的 SDK/浏览器部分及 UI-18/19/20 的上述基础已有证据，但 Task3有限 IPC、真实 A2 UI操作接线、Task4卡片/侧栏/宿主确认、Task5管理撤销信号与相关 Run 结算、Task6完整攻击与双窗口业务交错尚未完成。

未验证全部 file/javascript/worker/font/nested-frame 攻击、真实动作确认/旧 revision/重连组合；未做独立安全审查、完整 Desktop build 或人工 GUI验收。仍不公布 pluginUiLifecycle；没有首版参考插件或完整 UI-24–UI-26 交付证据。不合并、不推送、不发布。
