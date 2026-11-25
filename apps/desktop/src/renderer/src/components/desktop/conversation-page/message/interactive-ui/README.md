# 交互界面（Beta）

目前只支持回复里的可筛选表格。对话记录从已完成的运行和对应输入中核对是否启用了 `vykor-ui-v1`，由 Markdown 渲染器识别完整闭合的代码块。

- `interactive-ui-block.tsx` 校验代码块，失败时返回原来的 Markdown 代码块。
- `openui-library.ts` 注册 `FilterableTable`。OpenUI 只负责解析，桌面只接受一个使用字面量参数的组件。组件参数和行列大小在显示前校验。
- `filterable-table.tsx` 使用 Vykor 控件显示表格。筛选和排序留在当前组件，重新打开历史时从原消息恢复表格数据。

本机开关由主进程保存，消息和运行状态由后台保存。新增组件的参数与展示在这里维护，提示说明放在 `@vykor/prompts`。从 Markdown 进入的回归见 [消息测试](../markdown/__test__/assistant-markdown.interactive-ui.test.tsx)。
