# @vykor/memory

保存可复用的对话记忆，提供去重、更新、检索、提示词摘要和可选的 Markdown 文件存储。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/memory` 导入 `MemoryManager`、记忆类型、文件格式及抽取辅助函数。

| 文件与目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 源码导航、运行流程和扩展位置 |
| [src/memory-format.ts](src/memory-format.ts) | 记忆字段、Markdown 元信息和索引长度限制 |
| [src/extraction.ts](src/extraction.ts) | 构造抽取提示词、解析候选记忆和筛选可写记录 |
| [src/sensitive-content.ts](src/sensitive-content.ts) | 检测疑似密钥内容 |
| [src/__test__](src/__test__) | 记忆管理、抽取和敏感内容测试 |

宿主创建 `MemoryManager` 后增删改查，管理器按内容签名去重并拒绝疑似凭据。条目先保存在实例内存中；传入 `storageDir` 时，同时写入 `<id>.md` 和 `MEMORY.md` 索引，写操作串行执行。模型调用和会话结束时何时抽取记忆由宿主决定。

本包保持紧凑结构，新增管理、格式或抽取辅助文件放在 `src/`，对应测试放同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/memory test
```
