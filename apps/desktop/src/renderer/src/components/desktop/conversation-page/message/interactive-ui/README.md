# 交互界面（Beta）

支持可筛选表格。对话记录从正在运行或已完成的请求及对应输入中核对是否启用了 `vykor-ui-v1`。Markdown 渲染器在生成中传入代码块，表格列名完整后显示表头，逐行加入已经写完且通过校验的数据。校验失败或回复结束时仍未闭合，显示原代码块。

- `interactive-ui-block.tsx` 是代码块入口。它持有当前表格的解析器，把逐步确认的数据交给同一个表格。
- `openui-library.ts` 注册 `FilterableTable`，使用 OpenUI 的流式解析器。桌面只接受一个使用字面量参数的组件，显示前校验参数和行列大小。
- `filterable-table-stream.ts` 从原文提取写完整的标题、列和行，避免显示解析器补全的半截值。
- `filterable-table.tsx` 使用 Vykor 控件显示表格。筛选和排序留在当前组件，重新打开历史时从原消息恢复表格数据。

表格外框随聊天内容列缩放，最大宽度沿用 `--chat-content-width`，滚动区高度取 24rem 和窗口高度 55% 中的较小值。列按内容取宽，表头和单元格保持单行。鼠标或键盘可以在表格内横向、纵向滚动，纵向滚动时表头固定。筛选使用桌面共用的胶囊搜索框，清除筛选后焦点回到输入框。

本机开关由主进程保存，消息和运行状态由后台保存。新增组件的参数、允许提前展示的数据与界面在这里维护，提示说明放在 `@vykor/prompts`。逐行校验见 [解析测试](__test__/filterable-table-stream.test.ts)，聊天入口见 [会话测试](../../transcript/__test__/transcript.interactive-ui.test.tsx)。
