# Stage 8C：发行 A——首次正式弃用发行

> **历史计划，已被取代。** 当前依据是 [clean-slate 设计](../specs/2026-09-16-clean-slate-compatibility-removal-design.md) 与 [clean-slate 总计划](./2026-09-16-clean-slate-compatibility-removal.md)。以下正文仅保留决策历史，不再作为发行或删除门禁。

**目标：** 发布第一个真实包含 Stage 7 弃用声明的稳定版本，并登记首次证据。

## 发布前

- [ ] 8A、8B 已合并 main，CI 全绿。
- [ ] ledger deprecation/retention 均为 pending。
- [ ] 118 个 facade、JSDoc 和迁移表一致。
- [ ] release notes 包含弃用说明、替代入口和完整迁移窗口。

## 发布

- [ ] 以 `client-deprecation` 阶段触发 tag-release。
- [ ] 保存 workflow run URL 和证据 artifact。
- [ ] 验证 tag 指向构建 commit、npm 版本存在、Release notes 含弃用公告。

## 登记证据

- [ ] 用受测 helper 写入 ledger `releases.deprecation`，不手工复制 118 次。
- [ ] 验证 tag、commit、Stage 7 祖先关系、stable channel 和 URL。
- [ ] integrity check 通过；removal gate 仍因 retention pending 而 BLOCKED。
- [ ] 提交证据登记并再次通过 CI。

## 完成门槛

- [ ] tag、npm、Release、ledger 四方版本一致。
- [ ] 没有填写 retention 证据，也没有删除任何 facade。
