# 附件历史恢复实现计划

**目标：** 编辑重发、空闲回收或服务重启后，同一会话的附件仍可作为模型输入、通过 Read 重读，并作为图片编辑工具的参照。

**流程：** 数据库的输入附件引用是访问依据，原文件仍由附件存储负责。新建会话执行实例时，历史附件重新经过首次发送所用的能力判断与内容解析。模型看到稳定的附件地址；工具根据当前会话验证地址，再读取原文件，不把存储目录作为工具协议。

**实施边界：** 复用 AttachmentCapabilityRouter 和现有 Read、ImageGeneration，不新增数据库字段、工具或依赖。附件不可用时保留明确的资源状态，不能影响其他附件恢复。当前目录原地实施，保留原有未提交修改。

## 任务与验证

- [x] 先增加重启与编辑重发的集成回归，验证恢复的图片字节、文本及稳定地址，确认旧实现失败。
- [x] 在附件 resources 分类增加历史恢复入口；守住会话及原输入引用，按当前能力逐个恢复，隔离单个文件失败。
- [x] 在历史转换与 daemon loader 接入恢复结果；首次发送也提供相同的稳定地址。
- [x] 扩展授权附件读取，Read 可重新读取图片；验证跨会话、未就绪和损坏内容拒绝访问。
- [x] ImageGeneration 将已授权的附件地址转换为图片数据；请求前拒绝越权、非图片及本地路径。
- [x] 补齐附件目录说明，运行相关测试、服务端类型检查、`check:retired-ui` 与 `check-docs`。
- [x] 独立代码审查修复范围与权限边界，再运行受影响检查。

验证结果：相关测试共 17 个文件、198 项通过。四条真实生命周期回归分别覆盖编辑重发、重启、空闲回收与单个原文件缺失；校验恢复后的原图字节、文本和授权读取。服务端类型检查及两项仓库检查通过。独立审查发现的媒体格式判断与模型能力查询失败问题已补回归并修复。外部模型和图片服务使用测试替身，未发起真实生成请求。

## Ponytail 复核

历史恢复改为直接按会话和原输入查询已保存的附件引用，移除一次完整的消息转换，不再维护两个恢复来源。三个读取器共用引用查询，资源地址共用生成函数；没有增加依赖或数据库字段。

补充真实 Word、Excel、PPT 和超过 16K 的长文本重启读取回归，原件校验值保持不变；引擎缺失的环境按已有 Office 测试约定跳过引擎场景。生成图通过同会话中成功完成且已提交的 ImageGeneration 调用取得读取权限，普通插件工具伪造的生成图元数据不能授权。生成图消息被删除后撤销访问；本次不扩展手动压缩时保留生成图消息的既有规则。

## 检查命令

Corepack 在当前环境无法下载 pnpm，测试优先使用现有依赖的入口：

```powershell
# 在 packages/server 中运行
node ../../node_modules/vitest/vitest.mjs run src/application/__test__/attachment-history-lifecycle.test.ts
node ../../node_modules/vitest/vitest.mjs run src/application/attachments src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts src/application/agent/__test__/agent-transcript.test.ts src/daemon/__test__/daemon-agent.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit

# 在包根运行，相当于 package.json 中的同名检查
node --run check:retired-ui
node --run check-docs
```
