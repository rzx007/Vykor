# 交互命令

将会话、设置、诊断等界面操作组织成可复用命令。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [diagnostic-commands.ts](./diagnostic-commands.ts) | `handleDiagnosticCommand` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [job-commands.ts](./job-commands.ts) | `handleJobCommand` |
| [knowledge-commands.ts](./knowledge-commands.ts) | `handleKnowledgeCommand` |
| [plugin-presentation.ts](./plugin-presentation.ts) | `formatPluginReload` |
| [session-commands.ts](./session-commands.ts) | `SlashLine`、`PresentationReadRequest`、`RuntimeDiagnostics` |
| [settings-commands.ts](./settings-commands.ts) | `handleSettingsCommand` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

界面提供操作输入，命令调用资源接口，并把执行结果或后续动作返回给调用方。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
