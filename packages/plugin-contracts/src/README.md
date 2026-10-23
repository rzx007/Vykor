# 插件公共数据定义导航

这里按 manifest、市场与展示、运行期交接数据组织公共定义。各目录通过包中已有的公开子路径提供类型、常量或纯校验函数。

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [manifest/](./manifest/README.md) | 原生 manifest 字段、公用限额和字段检查 |
| [marketplace/](./marketplace/README.md) | 市场条目及各端共用的展示信息 |
| [runtime/](./runtime/README.md) | 插件与宿主之间的运行接口和可序列化数据 |

## 入口与处理步骤

从 `@vykor/plugin-contracts/manifest`、`/validation`、`/limits`、`/marketplace`、`/presentation`、`/runtime` 或 `/runtime-data` 引用所需定义。消费方检查数据后，再交给来源、安装或运行时模块处理。

## 状态放在哪里

这里定义传递数据的格式；安装文件、安装记录和活动连接由消费方管理。

## 新代码与测试

新增定义放入职责对应的分类，公开入口在包的 `package.json` 中维护。测试放在被测分类的 `__test__/`，跨分类测试放在本层 `__test__/`。
