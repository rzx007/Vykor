# 附件存储概览可视化融合实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变后台统计口径的前提下，把设计稿中的容量关系可视化融合进真实附件存储设置页。

**架构：** 纯函数根据 `physicalBytes` 和 `reclaimableBytes` 生成经过夹取的“当前保留/可清理”比例，React 页面只负责用现有设计 token 渲染比例条、说明项和精简统计区。去重节省保持独立指标，不参与实际占用分段。

**技术栈：** React 19、TypeScript、Vitest、Tailwind CSS、现有 Card/Button/Badge/Skeleton 组件和 Lucide 图标。

---

### 任务 1：锁定容量分段口径

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.ts`

- [x] **步骤 1：编写失败测试**

  新增 `storageComposition` 的表驱动测试，使用字面量期望值覆盖：

  ```ts
  expect(storageComposition(100, 25)).toEqual({ retainedBytes: 75, retainedPercent: 75, reclaimableBytes: 25, reclaimablePercent: 25 })
  expect(storageComposition(100, 150)).toEqual({ retainedBytes: 0, retainedPercent: 0, reclaimableBytes: 100, reclaimablePercent: 100 })
  expect(storageComposition(0, 10)).toEqual({ retainedBytes: 0, retainedPercent: 0, reclaimableBytes: 0, reclaimablePercent: 0 })
  ```

- [x] **步骤 2：运行测试确认 RED**

  运行：

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts
  ```

  预期：测试因 `storageComposition` 尚未导出而失败。

- [x] **步骤 3：实现最小纯函数并确认 GREEN**

  对非法、负数和超出实际占用的可清理量做归零或夹取，返回字节数和百分比。重新运行同一测试，预期全部通过。

### 任务 2：融合概览卡片并完成回归

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.ts`
- 修改：`docs/superpowers/specs/2026-08-29-conversation-attachments-release-closeout-design.md`

- [x] **步骤 1：编写失败的组件行为测试**

  使用现有完整报告夹具渲染真实组件，断言用户可见结果包含“当前保留”“去重节省”“可清理”和五个次级统计；给比例条增加 `aria-label`，断言其中包含手工推导的 `75%`/`25%` 分段说明。测试要因当前八宫格没有比例条而失败。

- [x] **步骤 2：实现融合布局**

  在 `StorageOverview` 中调用 `storageComposition`：右上显示实际占用，中部渲染两段比例条和三项带文本说明的图例，下部只保留附件总数、唯一文件、正在使用、正在导入、处理失败。使用现有语义 token 和响应式网格，不新增依赖或硬编码色值。

- [x] **步骤 3：格式化并完成验证**

  运行：

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.ts
  pnpm --filter @vykor/desktop test
  pnpm --filter @vykor/desktop typecheck
  pnpm check-docs
  git diff --check
  ```

  同时对本轮修改的 TypeScript/TSX 文件运行 ESLint，要求零警告。用户在真实设置页完成最终视觉反馈，自动化验证不替代实际观感判断。

- [x] **步骤 4：提交**

  ```powershell
  git add apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.ts apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.ts docs/superpowers/specs/2026-08-29-conversation-attachments-release-closeout-design.md docs/superpowers/plans/2026-08-29-attachment-storage-overview-visual-refinement.md
  git commit -m "refactor(desktop): visualize attachment storage composition"
  ```
