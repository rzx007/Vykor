# 插件市场来源

解析市场条目并取得对应插件归档。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [marketplace.ts](./marketplace.ts) | `OFFICIAL_MARKETPLACE_SOURCE`、`MarketplaceRequest`、`LoadedMarketplaceSource` |

## 入口与处理步骤

主要入口或定义见 [marketplace.ts](./marketplace.ts)。

先解析与检查市场信息，再下载或读取归档，返回来源信息供后续校验和安装。

## 状态放在哪里

来源准备使用调用方指定的工作目录或缓存目录；最终安装记录由 Plugins 包管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
