# 会话记录与标题

保存会话属性、工作树绑定，并提供默认标题识别与标题生成。

## 入口与流程

SessionRepository 读写会话及工作目录关联；标题函数判断占位标题，再从输入文本提取有限长度的首句，供创建与首轮输入使用。

## 状态归属

会话事实保存在共享状态与 SQLite，工作树目录及活跃执行由应用层管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreateSessionInput`、`UpdateSessionInput`、`ClearSessionWorktreeBindingInput` 等 |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [session-repository.ts](./session-repository.ts) | `SessionRepositoryOptions`、`SessionRepository` |
| [title.ts](./title.ts) | `isPlaceholderSessionTitle`、`formatSessionTitle` |

## 测试与维护

会话属性、工作树绑定与标题规则放在这里，消息内容和会话树历史操作放在 conversations。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
