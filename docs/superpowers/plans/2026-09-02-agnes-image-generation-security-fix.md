# Agnes 图片生成工具安全修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 在当前会话中逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除源码中的 Agnes 密钥，让图片工具只使用 Agnes 专用环境变量，并向 Agent 返回可判断的安全错误信息。

**架构：** `ImageGeneration` 不再复用聊天模型的 Settings。每次执行时从进程环境读取 `AGNES_API_KEY`，可选读取 `AGNES_IMAGE_BASE_URL` 和 `AGNES_IMAGE_MODEL`；HTTP 状态错误和本地异常都经过密钥脱敏后返回。

**技术栈：** TypeScript、Vitest、Node.js Fetch API、pnpm workspace。

---

### 任务 1：固定独立凭据与端点契约

**文件：**

- 修改：`packages/server/src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`

- [x] **步骤 1：编写失败测试**

增加测试，断言工具忽略 `context.settings.apiKey/baseUrl`，使用 `AGNES_API_KEY`、`AGNES_IMAGE_BASE_URL` 和 `AGNES_IMAGE_MODEL`；未设置 `AGNES_API_KEY` 时不调用服务商。

- [x] **步骤 2：验证测试因当前硬编码实现而失败**

运行：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts
```

预期：凭据、端点和缺少凭据用例失败。

- [x] **步骤 3：实现最小配置解析**

从环境变量解析：

```text
AGNES_API_KEY             必填
AGNES_IMAGE_BASE_URL      可选，默认 https://api.agnes-ai.cn/v1
AGNES_IMAGE_MODEL         可选，默认 agnes-image-2.5-flash
```

删除硬编码密钥及对 `context.settings` 的依赖。

- [x] **步骤 4：验证配置测试通过**

运行同一个定向 Vitest 命令，预期全部通过。

### 任务 2：让失败原因对 Agent 可判断

**文件：**

- 修改：`packages/server/src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`

- [x] **步骤 1：编写失败测试**

增加测试，断言：`401/403` 明确标记凭据被拒绝；`429` 明确标记限流并携带 `Retry-After`；Fetch 抛错时返回脱敏后的错误类型和消息。

- [x] **步骤 2：验证测试因当前通用错误而失败**

运行定向 Vitest，预期错误分类和异常详情用例失败。

- [x] **步骤 3：实现最小错误格式化**

保留 provider 响应正文；根据 `401/403/429` 添加稳定、可操作的前缀；捕获异常消息并替换其中可能出现的 Agnes key，输出长度限制为 1000 字符。

- [x] **步骤 4：验证定向测试通过**

运行定向 Vitest，预期全部通过。

### 任务 3：安全与回归验证

**文件：**

- 检查：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`
- 检查：`packages/server/src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts`

- [x] 运行 `pnpm --filter @vykor/server test`。
- [x] 运行 `pnpm --filter @vykor/server check-types`。
- [x] 运行 `git diff --check`。
- [x] 搜索当前工作树，确认旧密钥文本已不在受版本控制文件中。
- [x] 检查 `git diff`，确认没有改动用户已有的无关文件。
