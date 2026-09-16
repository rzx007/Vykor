# 阶段 6C：Frontend useServerSync 拆分实现计划

> 连续完成生产拆分，最后统一跑 Frontend 测试。

**目标：** 把 1333 行 useServerSync 拆为 connection、remote subscription、permission/jobs adapter、view model 与 actions，保持 Hook 返回值。

---

- [ ] 记录 Hook 当前返回字段和 action，作为兼容表。
- [ ] 提取 client factory/connection lifecycle。
- [ ] 提取 remote session subscription，复用 6B controller。
- [ ] 提取 permission selector，保持当前 session 最早 pending。
- [ ] 提取 Jobs remote adapter/polling，不混 Session durable reducer。
- [ ] 提取 action callbacks，使用阶段5 Resources。
- [ ] Hook 只组合 useState/useEffect/useMemo 和子模块。
- [ ] effect cleanup 只 abort/unsubscribe，不执行业务 merge。
- [ ] 保持 retry、loading、error、selected session 行为。
- [ ] 不改组件视觉和 App props。
- [ ] 提交 refactor(frontend): split server sync hook。

统一测试迁移原 useServerSync 全部场景，新增 generation/abort/EOF/reconnect，记录文件行数变化。
