# 运行与执行记录

保存运行、执行尝试、子任务及相关计时信息。

## 入口与流程

RunRepository 创建、更新和查询运行事实，校验状态变化并同步共享状态；commands 定义需要明确传入的运行操作。

## 状态归属

正式运行保存在 SQLite 和共享状态，临时会话的记录保存在内存；实际执行和取消由执行宿主负责。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreateRunInput`、`UpdateRunInput`、`CreateRunAttemptInput` 等 |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [run-repository.ts](./run-repository.ts) | `RunRepositoryOptions`、`RunRepository` |

## 测试与维护

运行事实的读写、状态约束和计时规则放在这里，运行排队和模型调用留在应用层。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
