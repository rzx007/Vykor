# @vykor/plugin-contracts

集中定义插件 manifest、市场、展示和运行期交接数据。

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 集中定义插件 manifest、市场、展示和运行期交接数据。 |
| [src/manifest/](./src/manifest/README.md) | 定义插件 manifest、公用限额及字段检查。 |
| [src/marketplace/](./src/marketplace/README.md) | 定义插件市场条目和各端共用的展示信息。 |
| [src/runtime/](./src/runtime/README.md) | 定义插件与宿主之间传递的运行接口和可序列化数据。 |

入口与流程：各消费方通过已有公开子路径引用定义或校验函数，检查数据后交给来源、安装或运行时模块处理。

状态归属：这里只保存类型、常量和纯函数定义；安装记录、文件内容及运行连接由消费方管理。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/plugin-contracts test
pnpm --filter @vykor/plugin-contracts check-types
```
