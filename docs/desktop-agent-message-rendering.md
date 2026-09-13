# Desktop Agent 消息渲染设计

> 状态：当前 Desktop 消息与文件变更渲染说明。

## 目标

桌面端的 Agent 回复需要同时承载 Markdown 正文、推理过程、工具执行、文件引用和本轮文件变更。正文优先保证阅读连续性，运行细节默认保持克制，但在需要排查时仍可展开查看。

## 显示结构

一条 Assistant 消息按以下顺序渲染：

1. 连续的文本 part 合并后交给 `Streamdown` 渲染。正在生成的最后一条消息使用 streaming 模式，历史消息使用 static 模式。
2. reasoning part 显示为可展开的“思考过程”，默认收起。
3. 同一个 `toolUseId` 的 tool 和 tool_result 合并为一条工具活动，避免输入和结果各占一个卡片。
4. error part 使用明确但不过度抢眼的错误提示。
5. 回合结束且发生文件写入时，在消息末尾展示“已编辑 N 个文件”。

用户消息继续使用靠右的轻量气泡；Assistant 正文不套大卡片，保持完整可读宽度。用户 text part 带有 `metadata.items` 时，按原顺序把 Skill item 渲染为行内名称，并保留相邻正文；绝对 `SKILL.md` 路径和 Skill 正文不进入消息展示。

## 文件引用

Markdown 链接和行内代码中的文件路径都可以成为文件入口。识别规则保持保守：必须带目录分隔符或常见文件扩展名，并排除 URL、命令参数和纯版本号。

点击文件入口后的流程：

1. `ConversationPane` 将路径提交给 `DesktopShell`。
2. `DesktopShell` 展开右侧工具面板并生成一次性文件打开请求。
3. `UtilityPanel` 激活文件工具。
4. `FilesTool` 在当前项目文件列表就绪后，复用现有 `workspace.readFile` 流程打开文件标签。

相对路径以当前项目目录为根；绝对路径只有位于当前项目目录内时才会转换为相对路径并打开。路径末尾的行号会保留在显示文本中，但当前版本只打开文件，不定位到具体行。

## 文件变更摘要

当前会话协议还没有独立的 file-change 事件，因此第一版只从结构化工具调用中提取，不解析普通回复文字：

- 根据写入类工具名称判断是否属于文件变更。
- 从 `input.path`、`filePath`、`file_path`、`target` 等结构化字段提取路径。
- 对 `apply_patch` 一类输入解析补丁头和增删行数。
- 工具仍在 pending/running 时不展示摘要；回合结束后再展示，避免列表跳动。

摘要默认展示前三个文件，可展开其余文件。文件行可点击并打开右侧文件工具。后续协议若增加结构化 file-change part，应直接替换提取器的数据来源，UI 组件无需改动。

## 组件边界

- `conversation-pane.tsx`：会话布局、输入框、消息分组和文件打开请求转发。
- `conversation/message-render-model.ts`：合并文本、配对工具、提取文件引用与文件变更，保持为可测试的纯函数。
- `conversation/assistant-message.tsx`：Streamdown、自定义文件节点、工具活动、错误和变更摘要。
- `desktop-shell.tsx` / `utility-panel.tsx` / `files-tool.tsx`：传递并消费一次性文件打开请求。

## 验收标准

- 标题、列表、引用、链接、行内代码、代码块和表格具有一致的 Markdown 排版。
- 流式内容不会反复重建整条历史消息。
- 文件路径表现为紧凑的文件入口，点击会展开右侧面板并打开文件。
- 工具输入和结果不会重复显示成两张卡片。
- 只有回合结束并检测到文件写入时才显示文件变更摘要。
- 明暗主题下正文、代码块、工具活动和变更摘要均有清楚层级。
