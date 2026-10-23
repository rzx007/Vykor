# Git 与本地 ZIP 来源

将 Git 来源或本地 ZIP 准备为候选插件目录。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [git-source.ts](./git-source.ts) | `ResolvedGitPluginSource`、`GitRunner`、`ResolveGitPluginSourceInput` |
| [local-zip.ts](./local-zip.ts) | `ResolvedLocalPluginZip`、`ResolvedLocalPluginArchive`、`resolveLocalPluginZip` |

## 入口与处理步骤

主要入口或定义见 [git-source.ts](./git-source.ts)。

解析来源参数，准备 Git 文件或解包 ZIP，检查候选位置后返回目录与来源信息。

## 状态放在哪里

来源准备使用调用方指定的工作目录或缓存目录；最终安装记录由 Plugins 包管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
