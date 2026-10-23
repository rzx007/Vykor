# 笔记记录与写入校验

统一笔记正文、版本和创建、更新请求，供笔记服务及客户端共用。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/notes` 公开入口 |
| [records.ts](records.ts) | 笔记记录、写入请求和正文长度上限 |
| [validation.ts](validation.ts) | 创建与更新请求解析，拒绝未知字段并检查正文和版本 |

调用方用 `parseCreateNoteInput` 或 `parseUpdateNoteInput` 校验请求。创建请求不能是空白正文，更新请求需要正整数 `expectedRevision`；随后由消费方比较版本并保存记录。

正文、当前版本及写入冲突由消费方管理，本目录不读写笔记文件。新增笔记字段和对应校验放本目录，测试建议放同层 `__test__/`。
