# 市场与展示字段

定义插件市场条目和各端共用的展示信息。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [marketplace.ts](./marketplace.ts) | `MarketplacePlugin`、`MarketplaceDocument`、`MarketplaceSource` |
| [presentation.ts](./presentation.ts) | `PluginPresentation`、`isPluginWebUrl`、`isPluginIconSource` |

## 入口与处理步骤

主要入口或定义见 [marketplace.ts](./marketplace.ts)。

市场或插件读取流程构造条目，经过检查后将展示字段交给客户端和界面。

## 状态放在哪里

这里只保存类型、常量和纯函数定义；安装记录、文件内容及运行连接由消费方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
