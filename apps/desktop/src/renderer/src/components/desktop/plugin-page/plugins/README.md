# 插件管理

插件列表、详情、编辑、模板和快速开始。

## 放置边界

插件业务集中于此；常驻应用由 shell/plugin-apps 承载；会话工具结果在 conversation-page/message 渲染。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [plugin-manager.tsx](plugin-manager.tsx)
- [plugin-detail.tsx](plugin-detail.tsx)
- [plugin-editor.tsx](plugin-editor.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。

市场浏览与来源管理由 marketplace.tsx 承载；权限确认仅传递主进程生成的选择编号，安装状态来自服务端操作回执，新版本供下次对话使用。

市场与已安装共用 plugin-detail.tsx 的详情主体；marketplace-detail.tsx 只负责把目录展示信息与安装入口接入详情，不构造已安装状态或绕过权限判断。两处列表复用 shared/plugin-catalog.tsx，描述统一单行省略。
