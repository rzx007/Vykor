# 数据库维护与打包检查脚本

维护数据库测试清单，并检查打包后能否应用迁移链。

## 入口与流程

`update-schema-inventory.mjs` 只从仓库迁移链生成数据库测试数据；打包基线测试用 Bun 生成两种资源布局并用 Node 打开和重新打开空库。

## 状态归属

脚本在临时数据库或测试目录中工作，生成的结构清单放在数据库测试的 fixtures 中。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [update-schema-inventory.mjs](./update-schema-inventory.mjs) | 内部实现或维护脚本 |

打包基线测试：[bundled-baseline.test.ts](./__test__/bundled-baseline.test.ts)。在仓库根运行 `pnpm --filter @vykor/services test:bundled-baseline`。

## 测试与维护

可重复执行的维护工具放在本层，带断言的打包检查放在 `__test__/`，同步 package.json 中的命令。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
