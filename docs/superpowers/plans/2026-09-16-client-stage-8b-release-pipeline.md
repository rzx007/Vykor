# Stage 8B：可验证的 A/B/C 发布流水线

**目标：** 让实际发布流程产生门禁可验证的证据，并避免失败构建留下“看似有效”的正式发布。

## 任务 1：发布阶段输入

- [x] 为 `.github/workflows/tag-release.yml` 增加受限输入：`regular`、`client-deprecation`、`client-retention`、`client-breaking-removal`。
- [x] A、B、C 只接受各自阶段输入；输入与 ledger 状态不匹配时 preflight 失败。

## 任务 2：tag 前 preflight

- [x] 不在 validate 的开头创建并推送 tag。
- [x] 先 checkout 精确 SHA、安装依赖、同步候选版本到临时工作树。
- [x] 运行类型检查、全量测试、`check:architecture`、文档检查、脚本测试和对应阶段检查。
- [x] A/B 必须证明 118 个 facade 仍存在；C 必须证明 READY 授权已经被删除提交消费，且 facade 已消失。
- [x] build/package 成功后才能 finalize tag；前置失败不得留下远端 tag。

## 任务 3：release notes 模板

- [x] A notes 明确弃用、迁移指南、最早删除窗口。
- [x] B notes 明确本版本仍保留 118 个兼容方法，并宣布下一 major 可删除。
- [x] C notes 列出 breaking removal、旧名迁移表和 major 升级指引。
- [x] Release 重跑必须更新/验证 notes，不能只上传 artifact。
- [x] 为模板生成器编写结构测试。

## 任务 4：发布依赖和证据产物

- [x] GitHub Release 必须依赖 npm publish 成功；npm 失败不得产生可登记 release URL。
- [x] finalize 输出 version、tag、commit、publishedAt、workflowRunUrl、releaseNoteUrl、npm package/version 和校验状态。
- [x] 在线检查 `npm view @rzx/ohs@<version>` 与预期版本一致。
- [x] 证据产物上传并在 job summary 展示，供 8C/8D 登记。

## 任务 5：失败演练

- [x] 测试失败时无 tag；npm 失败时无可登记 Release。
- [x] 已有 tag 指向其他 commit 时失败。
- [x] Release 重跑时 notes 与 artifact 保持一致。

## 完成门槛

- [x] workflow YAML、release helper 测试和文档通过。
- [x] A/B/C 三种 dry-run 都生成预期 notes 和证据结构。
- [x] 常规 release 不会意外修改 removal ledger。
