# 模型供应商设置

供应商列表、连接、自定义表单、默认模型与请求头。

## 放置边界

供应商专属的表单和校验归此类；模型实际调用和密钥存储留在已有服务。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [provider-settings.tsx](provider-settings.tsx)
- [provider-settings-list.tsx](provider-settings-list.tsx)
- [provider-connection-dialog.tsx](provider-connection-dialog.tsx)
- [provider-defaults-control.tsx](provider-defaults-control.tsx)：默认模型入口。首次读取生成本地草稿，模型、供应商和思考方式统一保存；取消只恢复草稿，不发送请求，不改已有对话。

## 默认模型布局

模型信息与更换入口在上方，思考方式使用单行分段控件，窄容器允许在控件内部横向滚动。模型详情独占底部一行，复用 beUI Collapsible 按需展开，避免详情挤压思考选项。保存和取消只在有待保存设置时出现；错误沿用当前表单提示和共享 toast。加载、草稿和保存状态由 `ProviderDefaultsControl` 持有，实际持久化沿用 `providerDefaults` 与 `sessions.setDefaultModel` 接口。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
