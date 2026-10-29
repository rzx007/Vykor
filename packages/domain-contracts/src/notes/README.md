# 笔记记录与写入校验

统一笔记正文、版本和创建、更新请求，供笔记服务及客户端共用。

| 文件                               | 用途                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| [index.ts](index.ts)               | `@vykor/domain-contracts/notes` 公开入口                                                       |
| [records.ts](records.ts)           | 笔记记录、写入请求和正文长度上限                                                               |
| [validation.ts](validation.ts)     | 创建与更新请求解析，拒绝未知字段并检查正文和版本                                               |
| [organization.ts](organization.ts) | 文件夹、桌面顺序、归属、条件保存类型；结构校验、对账与排序、合并、移入移出、重命名、解散纯函数 |

组织模型不引用 Node 或文件系统，可由渲染端和服务端共用。`parseSaveNoteOrganizationInput` 校验完整保存请求，拒绝重复归属、单张文件夹和未知字段，名称按 Unicode 字符限制为 1–80，ID 只允许安全文件名字符，项目总数上限为 10,000。`reconcileOrganization` 用正文 ID 列表修复磁盘上的重复或失效引用，所有操作返回新快照，不修改入参。组织状态只保存在 `organization.json`，`etag` 由文件仓库生成和比较。

`parseNoteOrganization(value, noteIds?)` 一次解析结构后检查归属；传入现有便签 ID 时，还检查缺失与多余引用。公开的 `assertOrganizationInvariants` 仍先检查结构，直接调用时不会信任未经校验的对象。HTTP 与应用入口各自保留请求校验，文件仓库在写入时按最新存在的便签再次校验。

调用方用 `parseCreateNoteInput` 或 `parseUpdateNoteInput` 校验请求。创建请求不能是空白正文，更新请求需要正整数 `expectedRevision`；随后由消费方比较版本并保存记录。

正文、当前版本及写入冲突由消费方管理，本目录不读写笔记文件。新增笔记字段和对应校验放本目录，测试建议放同层 `__test__/`。
