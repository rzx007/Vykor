# 文件浏览

文件树、面包屑、搜索、文件预览和文件类型图标。

## 放置边界

管理文件如何被浏览与选择；代码编辑由 editor 提供，评审由 review 提供。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [files-tool.tsx](files-tool.tsx)
- [file-viewer.tsx](file-viewer.tsx)
- [project-file-tree.tsx](project-file-tree.tsx)
- [file-viewer-toolbar.tsx](file-viewer-toolbar.tsx)：面包屑、渲染/源码切换、文件树及刷新操作，复用胶囊控件并允许窄面板换行。
文件树中的 HTML/SVG 直接在独立的内置浏览器标签打开，不在文件面板内嵌浏览器。Markdown 保留源码与渲染切换，顶部操作与文件树操作共用胶囊工具栏。

正文请求中末尾带斜杠的目录通过工作区服务交给系统文件管理器打开；项目外目录需使用绝对路径，仍检查配置目录和符号链接的实际位置，不扩大目录扫描或写入范围。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
