# 插件与 MCP 扩展

定义插件应用、市场、展示、历史记录和 MCP 授权数据。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [mcp-oauth.ts](./mcp-oauth.ts) | `MCP_OAUTH_FEATURE`、`MCP_OAUTH_LOGIN_UPDATED_EVENT`、`MCP_OAUTH_LOGIN_COMPLETED_EVENT` |
| [plugin-apps.ts](./plugin-apps.ts) | `PluginAppToolRequest`、`PluginAppAvailability`、`PluginAppResponse` |
| [plugin-marketplace.ts](./plugin-marketplace.ts) | `MarketplaceCatalogRequest`、`MarketplaceSourcesResponse`、`MarketplaceAddSourceRequest` |
| [plugin-presentation.ts](./plugin-presentation.ts) | 统一导出本分类的类型与函数 |
| [plugin-ui-history.ts](./plugin-ui-history.ts) | `parsePluginUiConversationReceipt`、`parsePluginUiSubmissionRecord`、`parsePluginUiRouteIds` |

## 入口与处理步骤

主要入口或定义见 [mcp-oauth.ts](./mcp-oauth.ts)。

插件或 MCP 服务产生可展示的数据，协议层检查和复制必要字段，再交给客户端或请求处理方。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
