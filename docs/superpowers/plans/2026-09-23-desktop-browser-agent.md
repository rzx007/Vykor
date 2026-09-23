# 桌面浏览器 Agent 一期实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划，步骤使用复选框跟踪。

**目标：** 让桌面 Agent 通过窄权限工具操作现有 `<webview>`，查看页面结构和截图，并根据用户标注及操作结果迭代。

**架构：** Electron 主进程持有已绑定的 guest WebContents，并实现 Server 暴露的 `BrowserHost` 能力接口。Desktop 只把该宿主能力交给内嵌 daemon；Server 在组装 Agent Runtime 时创建 Browser 工具，并将截图存入附件库。Renderer 负责绑定 tab 和提供元素标注。

**技术栈：** Electron 39、React、TypeScript、daemon 工具注册、现有 `ImageBlock` 视觉输入。

---

## 文件职责

- `packages/server/src/application/browser-tools/`：定义 Browser 动作、观察结果与 `BrowserHost` 接口，并实现只供 Server Agent Runtime 注入的 Browser 工具。
- `packages/server/src/http/server.ts`、`packages/server/src/application/daemon-application.ts`：接收可选 `BrowserHost`，在 Agent Runtime 组装业务工具，并把截图持久化到附件库。
- `apps/desktop/src/main/features/browser/`：活动标签注册、站点授权、窄动作执行、截图字节及标注的主进程服务。
- `apps/desktop/src/main/features/session/daemon-connection-service.ts`：将可选 `BrowserHost` 传给 Server；不创建或组装 Agent 工具。
- `apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`：定义并暴露最小 Browser IPC。
- `apps/desktop/src/renderer/src/components/desktop/tools/browser-tool.tsx`：绑定 `<webview>`，提供用户标注交互。
- 当前实现未新增自动化测试；本次验证使用各相关 workspace 的 TypeScript 类型检查。

## 任务 1：定义 Browser Host 与工具

- [x] 在 Server 应用层定义 Browser Host 能力和有限动作类型，并通过 Server 公共入口转出宿主接口。
- [x] Server 应用层组装 `Browser` 动态工具；工具校验动作及参数，将宿主返回的截图存入附件库，再以 `ImageBlock` 返回视觉输入。
- [x] Desktop 只实现并注入 `BrowserHost`；Server 始终注册 Browser 工具，并在没有宿主时以明确描述和受控错误告知当前运行环境不可用。

## 任务 2：连接 Electron 主进程与 daemon

- [x] 通过 Electron `did-attach-webview` 记录 guest WebContents，并要求 Renderer 明确绑定 tab ID。
- [x] 校验 Browser IPC 的 sender、tab ID 和当前活动页；tab 关闭时移除映射。
- [x] 在主进程实现导航、页面可见结构读取、点击、输入、滚动和截图；动作只接受有限结构化参数。
- [x] 新 origin 首次操作前请求用户授权；检测到表单提交或高影响按钮时等待用户确认。
- [x] 给 Server daemon 增加可选 `browserHost` 宿主能力，并仅在 desktop embedded daemon 启动时传入。
- [x] 若 Browser 工具没有宿主，向模型返回清晰错误，不尝试开外部调试端口。

## 任务 3：接入用户标注并收尾

- [x] 在浏览器面板增加标注模式：用户点选元素后展示简短标签与评论输入框。
- [x] 将 URL、元素角色/名称、有限 DOM 摘要和评论作为 Browser 工具上下文提供给 Agent。
- [x] 复查一期范围：没有任意 JavaScript、完整 CDP、Console、Network、Cookie 或请求正文读取。
- [x] Core、Tools、Server、Desktop 主进程与 Renderer 类型检查通过；未运行完整测试或构建。
