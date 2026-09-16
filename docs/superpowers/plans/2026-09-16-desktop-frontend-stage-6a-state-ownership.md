# 阶段 6A：状态所有权与纯对账实现计划

> 批量实现；阶段 6 全部代码完成后统一测试和审查。

**目标：** 固定 durable、connection、operation、draft、view、platform 状态所有权，消除重复 durable merge。

**架构：** packages/client reducer/snapshot 是 durable 唯一基础；平台只持 lifecycle 和局部 UI 状态。

---

- [ ] 盘点 useServerSync、Desktop SessionService、renderer store 全部字段并分类。
- [ ] 为重复的 Session/Message/Part/Run/Task/Permission merge 建立清单。
- [ ] 将两个真实平台共用的纯 snapshot/event/cursor helper 收敛到 packages/client/state。
- [ ] 删除平台内与 applyEvent/applySessionSnapshot 等价的纯 merge。
- [ ] 保留 optimistic/draft/view 状态在平台 feature。
- [ ] 新增架构规则：platform 不复制 Client durable reducer；Frontend 不导入 Electron；renderer 不导入 Desktop main。
- [ ] 更新 README 状态矩阵。
- [ ] 必要类型快检；提交 refactor(client): establish platform state ownership。

统一测试覆盖旧 cursor、重复 seq、snapshot 不回退、transient delta、permission 顺序和 immutable state。
