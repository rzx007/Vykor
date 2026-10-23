# @vykor/json-data

提供与业务无关的 JSON 类型、校验、稳定序列化和有限大小复制函数。公开入口只有 `@vykor/json-data/json`，对应 [src/json.ts](src/json.ts)，声明见 [package.json](package.json)。

## 目录导航

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | JSON 辅助函数及同层测试 |

调用方传入未知数据及大小限制，函数返回校验结果、序列化文本或独立副本。业务记录和限制值由调用方管理；函数只在一次调用期间保存计数和遍历状态。

本包职责单一，新增通用 JSON 处理放 `src/json.ts`，测试放 [src/__test__](src/__test__/)。业务字段校验放对应领域包。
