# 记忆条目契约

定义记忆正文、来源和版本，以及编辑、清空操作需要携带的预期版本。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/memory` 公开入口 |
| [records.ts](records.ts) | 记忆条目、版本引用、编辑和清空输入 |

消费方用 `MemoryEntryRecord` 交换记忆数据，编辑时提交 `expectedRevision`，清空时提交预期条目与版本列表。这里仅定义数据，不读取记忆、不检查实际版本，也不执行清空。

记忆正文、来源信息和版本比较由消费方管理。新增记忆共用字段放本目录，相关测试建议放同层 `__test__/`。
