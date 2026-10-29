# 桌面搜索

全局搜索对话框及结果交互。

## 放置边界

这里处理跨会话搜索入口；文件搜索与设置搜索分别留在 tools/files 和 settings-page/navigation。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [desktop-search-dialog.tsx](desktop-search-dialog.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。

正文搜索仍使用已有的侧栏入口、`DesktopSearchDialog` 和宿主搜索接口。选择内容结果时把消息 ID 与关键词交给 MainLayout 的短期导航目标，待指定聊天加载完成后由聊天内查找消费；普通标题结果保持只打开聊天。不会创建第二套全文索引或修改消息内容。
