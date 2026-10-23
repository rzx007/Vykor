# 模型供应商设置

供应商列表、连接、自定义表单、默认模型与请求头。

## 放置边界

供应商专属的表单和校验归此类；模型实际调用和密钥存储留在已有服务。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [provider-settings.tsx](provider-settings.tsx)
- [provider-settings-list.tsx](provider-settings-list.tsx)
- [provider-connection-dialog.tsx](provider-connection-dialog.tsx)
- [provider-defaults-control.tsx](provider-defaults-control.tsx)：默认模型入口。首次读取后，供应商、模型和思考方式的选择会自动保存，只影响新对话。

## 默认模型布局

模型信息与更换入口在上方，说明收进标题旁的 tooltip。输入能力读取 `ModelInfo.inputModalities` 与明确的图片能力，以文本、图片、视频、音频、PDF 图标展示，悬停或键盘聚焦可查看含义；不猜测未知的多模态能力，不展示保存状态标签。

思考方式使用单行分段控件，窄容器允许在控件内部横向滚动。模型详情独占底部一行，复用 beUI Collapsible 按需展开，避免详情挤压思考选项。

选择立即反映在界面，停止切换 400 毫秒后合并保存；切回原值不提交，离开设置时立即提交最后一次待保存选择。再次进入时等上次保存完成再读取，避免显示旧值。请求和列表刷新期间禁用切换，防止并发覆盖。没有保存、取消按钮或成功提示；写入接口报错后重新读取真实设置，无法确认时先隐藏选项并提供重新读取入口。加载、草稿和请求状态由 `ProviderDefaultsControl` 持有，实际持久化沿用 `providerDefaults` 与 `sessions.setDefaultModel` 接口。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
