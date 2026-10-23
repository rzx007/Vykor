# @vykor/plugin-sources

从 Git、本地 ZIP 或插件市场定位并取得可供安装的插件目录。

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 从 Git、本地 ZIP 或插件市场定位并取得可供安装的插件目录。 |
| [src/marketplace/](./src/marketplace/README.md) | 解析市场条目并取得对应插件归档。 |
| [src/sources/](./src/sources/README.md) | 将 Git 来源或本地 ZIP 准备为候选插件目录。 |
| [scripts/](./scripts/README.md) | 把示例原生插件目录打包为可分发的 ZIP。 |

入口与流程：先解析来源或市场条目，再下载、解包或准备 Git 工作目录，返回候选目录及来源信息，交给插件校验和安装流程。

状态归属：来源准备使用调用方指定的工作目录或缓存目录；最终安装记录由 Plugins 包管理。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/plugin-sources test
pnpm --filter @vykor/plugin-sources check-types
```
