# 插件资源与应用规则

访问插件、插件应用和插件界面历史，并提供应用展示策略。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [plugin-app-policy.ts](./plugin-app-policy.ts) | `getPluginAppToolPolicy` |
| [plugin-app-resource.ts](./plugin-app-resource.ts) | `PluginAppResource` |
| [plugin-resource.ts](./plugin-resource.ts) | `PluginResource` |
| [plugin-ui-history-resource.ts](./plugin-ui-history-resource.ts) | `PluginUiHistoryResource` |

## 入口与处理步骤

主要入口或定义见 [plugin-app-policy.ts](./plugin-app-policy.ts)。

先取得插件或应用信息，再提交对应操作；应用策略函数供命令和界面判断展示方式。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
