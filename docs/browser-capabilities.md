# Desktop 浏览器能力

> 状态：当前实现。以下 Agent 浏览器能力需要 Desktop 内嵌浏览器；没有 Desktop Browser 宿主的 CLI 或独立 daemon 会返回不可用。

## 普通 Browser

Desktop 右侧浏览器面板使用独立的浏览器资料目录。用户可以自己打开页面；Agent 使用 `Browser` 工具时，只操作面板里当前活动的标签页。没有标签页时，Agent 可通过 `navigate` 携带 URL 打开新标签页。

| 动作 | Agent 能做什么 |
| --- | --- |
| `inspect` | 读取当前页 URL、标题、有限的可见文字和可操作元素；模型支持图片输入时还可获得截图。 |
| `navigate` | 打开 HTTP、HTTPS 或当前工作区内的本地文件页面。 |
| `click` / `type` | 使用最近一次观察返回的元素 ID 点击或输入；页面变化后旧 ID 会失效。 |
| `scroll` | 向上或向下滚动，并重新观察页面。 |

Agent 首次访问一个站点时会请求当前会话的站点授权。点击可能提交表单、付款、删除数据的控件，或输入敏感信息时，还会请求操作确认。网页文字是不可信内容，不能替用户批准操作或改变 Agent 的权限。普通 `Browser` 不接受任意 JavaScript 或原始 CDP 命令，也不读取控制台、网络请求正文或 Cookie。

## Developer mode

在 Desktop 设置的“常规 → 权限 → 开发者模式”打开开关。它默认关闭，设置保存在当前设备。打开开关只是允许提出调试请求；检查当前站点前，Agent 仍须先取得普通站点授权，再取得本次 `BrowserDeveloper` 授权。授权卡会显示目标站点或本地文件、检查类别和数据风险。一次批准不会自动用于另一次检查、其他会话或子会话。

`BrowserDeveloper` 提供以下固定动作：

| 动作 | 返回或效果 |
| --- | --- |
| `inspect_dom` | 检查主框架的有限 DOM 树，可用 CSS 选择器定位元素。敏感字段属性会作尽力过滤。 |
| `inspect_styles` | 读取指定元素的有限计算样式。 |
| `start_diagnostics` | 批准后开始采集控制台和网络诊断事件。 |
| `read_diagnostics` | 读取本次采集的有限结果，不再弹出新的批准请求。 |
| `stop_diagnostics` | 由采集所属会话立即停止采集，不再弹出新的批准请求。 |

排查页面加载问题时，可以先 `start_diagnostics`，再用普通 `Browser` 导航或点击以复现问题，随后 `read_diagnostics`，最后 `stop_diagnostics`。采集只记录批准之后的控制台消息和已完成或失败的网络请求，不回溯之前的事件。采集最多持续 60 秒；切换活动标签页、关闭开关、通过 Desktop 删除会话或跨站导航也会结束采集。同站重载会清空旧页面事件，再采集新页面事件。同一时间只允许一个会话采集。

控制台只包含主框架的有限消息；网络只包含主框架发起的请求，也可能列出它请求的第三方资源 URL。网络结果只保留处理后的 URL、方法、资源类型、状态、失败原因和耗时；URL 的查询参数及 `data:` 内嵌内容会被遮蔽。不会读取或返回请求/响应头、Cookie、请求/响应正文及 WebSocket 帧。事件数量和工具结果大小都有上限，超出的结果会标记为截断。

Developer mode 是四类受控检查能力，不提供任意 CDP 方法或脚本执行。网页仍可能把秘密写在 DOM 文字、URL 路径或控制台自由文本里，过滤规则无法保证识别所有敏感内容；请在批准前确认站点和任务是否确实需要这些数据。

## 实现入口

普通动作由 `packages/server/src/application/browser-tools/browser-tool.ts` 定义，Desktop 的 `apps/desktop/src/main/features/browser/browser-agent-service.ts` 负责选择标签页并执行。开发者动作由同目录的 `browser-developer-tool.ts` 定义；Desktop 的 `browser-developer-inspector.ts` 负责固定 CDP 检查、有限采集和清理。授权请求由 `packages/server/src/permissions/permission-broker.ts` 管理，Developer mode 的开关保存在 Desktop 本地偏好中。

## 用户批注

工具栏的批注按钮进入选择模式：悬停显示元素边框和名称，点击锁定后在目标旁填写意见。保存后出现编号标记，可以继续选择；点击编号或批注数量打开列表，定位或删除已保存意见。选择模式保留主文档的原生滚动，点击目标不会执行目标本身的网页点击处理器。

输入框支持 `Ctrl/Cmd + Enter` 保存，Enter 换行，Escape 取消当前输入或结束选择。保存失败、切换标签页、隐藏工具面板或页面变化后保留当前组件中的草稿文字，但旧目标关联失效，需要重新选择才能提交。页面中的键盘选择使用网页原有 Tab 焦点和 Enter；列表中的定位与删除按钮可通过键盘操作。

每个标签页只在主进程内存中保留当前页面的至多 20 条批注，意见最多 2,000 字。同地址刷新保留记录，唯一 ID 或基于稳定属性/类名的目标重新核对后可以定位；结构路径的原元素失效后显示“目标位置暂不可用”，不猜测另一个同名元素。完整页面地址改变或 guest 销毁时清空记录，退出应用后不恢复。

批注支持普通 HTML、React、Vue 等主文档，不依赖 React Scan。iframe 只支持选择外层元素，选择模式下不能操作其内部；不遍历 Shadow DOM 内部节点。已保存的当前页面批注及其有限选择器随普通 Browser 观察结果返回给 Agent，草稿和实时坐标不进入模型上下文；选择器是说明数据，不增加新的工具动作或权限。

CSS 选择器使用固定版本 `@medv/finder`，只在锁定目标时生成。构建阶段把库和选择器规则打包成自包含的浏览器脚本，进入选择时注入隔离执行环境，后续悬停与读取不重复加载库。只允许有限的测试标识属性和经过筛选的 ID/类名，仍会在恢复时核对唯一性及元素特征，不保证页面改写后始终对应原语义目标。

Agent 执行导航、点击、输入或滚动时，在通过现有授权后结束页面选择模式，避免批注的点击捕获挡住自动操作；已保存记录保留，未保存意见保留在界面草稿中。只读 `inspect` 不结束选择。

代码职责和生命周期见 [批注设计](./superpowers/specs/2026-10-04-desktop-browser-annotations-design.md)，实施与验证记录见 [实施计划](./superpowers/plans/2026-10-04-desktop-browser-annotations.md)。
