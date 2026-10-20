# 设置内容

设置内容入口、分类路由和各项设置表单。

## 放置边界

根目录保留组合入口；每项设置及相关表单、模型、弹层放进对应功能子目录。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [index.ts](index.ts)
- [settings-content.tsx](settings-content.tsx)

## 子分类

- [账户设置](account/README.md)：个人资料和账户相关设置展示。
- [配置迁移设置](configuration/README.md)：配置导入、导出和导入预览。
- [外部连接设置](connections/README.md)：连接渠道、飞书连接详情和配置弹层。
- [诊断设置](diagnostics/README.md)：诊断信息、日志查看与展示格式。
- [常规设置](general/README.md)：对话显示、常用偏好、自动启动、编辑器和快捷键设置。
- [设置导航与搜索](navigation/README.md)：设置分类定义、导航和搜索匹配。
- [通知设置](notifications/README.md)：通知开关和提示音偏好。
- [权限设置](permissions/README.md)：权限偏好和审批管理界面。
- [个性化设置](personalization/README.md)：自定义指令、记忆偏好和记忆管理。
- [插件设置入口](plugins/README.md)：设置页内的插件设置组合与内容选择。
- [模型供应商设置](providers/README.md)：供应商列表、连接、自定义表单、默认模型与请求头。
- [运行环境设置](runtime/README.md)：运行环境选项、任务偏好及设置模型。
- [设置共享组件](shared/README.md)：设置行、帮助信息、状态与错误展示。
- [存储设置](storage/README.md)：存储占用、附件清理、格式化和图形展示。
- [终端设置](terminal/README.md)：默认终端、Shell 选择和终端偏好。
- [用量设置](usage/README.md)：模型和会话用量的统计展示。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
