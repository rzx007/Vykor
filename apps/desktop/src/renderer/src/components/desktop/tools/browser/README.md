# 浏览器工具

内嵌浏览器导航、样式注入、截图与标注。

## 放置边界

浏览器专属交互集中于此；独立图片编辑和预览使用 image-viewer。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [browser-tool.tsx](browser-tool.tsx)
- [use-browser-annotations.ts](use-browser-annotations.ts)
- [browser-prompt-context.ts](browser-prompt-context.ts)：发送消息前读取当前页面已保存的批注，形成消息上下文；编辑重发时根据原消息移除旧批注块，保留新增正文和引用。
- [browser-navigation.ts](browser-navigation.ts)

## 批注随消息发送

聊天发送入口调用 `captureBrowserAnnotationContext(scopeId)`，从工具面板已有状态中确认该聊天的面板已打开、当前标签是浏览器且页面加载完成，再使用已有的 `readAnnotations` 读取批注。读取完成后重新核对标签、网址和面板状态；页面切换或关闭后完成的旧请求返回空值，同页读取失败会给出错误，避免无提示漏带批注。没有可读页面时同步返回 `null`。

上下文只包含当前页面网址和已保存批注的目标、用于定位页面元素的 CSS 选择器与意见，放在消息末尾的 `<browser_annotations>` 文本块中；草稿不随消息发送，也不截图。批注原始状态仍由主进程保存，此模块只生成发送时的文字快照。

编辑入口调用 `stripBrowserAnnotationContext(items, sourceItems)`，从原消息末尾边界完整、JSON 格式有效的快照提取原文，在编辑消息中从后往前精确移除一次，因此快照后新增的正文和引用都能保留。未提供原消息或原消息没有有效快照时，只尝试移除编辑消息末尾的有效快照，不删除正文中间手写的批注示例；原消息条目均不修改。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
