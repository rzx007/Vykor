# 桌面组件分类

桌面界面的功能入口、布局和工具面板。

## 放置边界

先按功能查找目录；基础 UI 继续使用 components/ui，运行逻辑留在对应 stores、lib 或主进程模块。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 子分类

- [对话页面](conversation-page/README.md)：主对话入口及输入、消息、记录和会话控制。
- [图片查看与标注](image-viewer/README.md)：图片来源、查看器、面板和标注状态。
- [桌面布局](layout/README.md)：窗口框架、主界面、设置界面与面板布局。
- [笔记页面](notes-page/README.md)：笔记列表、详情、编辑、保存协调和恢复。
- [外部打开方式](open-with/README.md)：打开方式选择、图标、按钮和工作区打开动作。
- [桌面宠物页面](pet-page/README.md)：宠物页面的展示与交互入口。
- [扩展管理页面](plugin-page/README.md)：插件、Skill 和 MCP 的管理入口。
- [计划任务页面](scheduled-page/README.md)：计划任务列表、详情、编辑和动作菜单。
- [桌面搜索](search/README.md)：全局搜索对话框及结果交互。
- [设置内容](settings-page/README.md)：设置内容入口、分类路由和各项设置表单。
- [桌面共享展示](shared/README.md)：多个桌面功能共同使用的轻量展示组件。
- [桌面全局行为](shell/README.md)：会话事件桥接、全局快捷键和通知宿主。
- [工具分类](tools/README.md)：主界面工具面板承载的各类工具。
- [桌面更新](update/README.md)：桌面更新状态与更新提示控件。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](AGENTS.md)。

[目录约定测试](__test__/desktop-structure.test.ts) 会检查分类说明、根目录散落代码，以及测试、基准测试和测试辅助文件的位置。新增分类或测试后，应保持这项检查通过。

在 `apps/desktop` 下运行目录检查：

```sh
node ../../node_modules/vitest/vitest.mjs run src/renderer/src/components/desktop/__test__/desktop-structure.test.ts
```

业务修改另外运行对应分类的测试；跨分类移动后再执行 Web 类型检查。
