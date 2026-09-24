# Codex 风格 Markdown 输出与正文排版实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 VK 增加可单点关闭的 Markdown 表达规范，并收紧桌面对话正文排版，使普通回答和技能回答更接近 Codex 的阅读体验。

**架构：** `@vykor/prompts` 提供一个纯函数生成稳定的 Markdown 表达规范，由系统提示词装配器在唯一入口注入；关闭选项只影响这一段。桌面端保留 Streamdown 解析，只在助手对话区域增加宽度和 Markdown 元素覆盖，不修改第三方技能或输出内容。

**技术栈：** TypeScript、Vitest、React、Streamdown、Tailwind CSS 4、CSS

---

## 文件职责

- 修改 `packages/prompts/src/index.ts`：定义并导出 Markdown 表达规范生成函数，在运行时提示词选项中公开关闭选项。
- 修改 `packages/prompts/src/prompt-segments-assembly.ts`：在稳定系统层的单一位置装配表达规范。
- 修改 `packages/prompts/src/index.test.ts`：验证默认启用和显式关闭的扁平系统提示词。
- 修改 `packages/prompts/src/ledger-segments.test.ts`：验证规范进入稳定 `system` 分段。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：只拓宽消息正文区域。
- 修改 `apps/desktop/src/renderer/src/assets/main.css`：增加助手消息专用的标题、列表、引用块、段落和链接覆盖。
- 修改 `apps/desktop/src/renderer/src/markdown-table-styles.test.ts`：扩展为对话 Markdown 排版样式回归测试。

### 任务 1：注入可关闭的 Markdown 表达规范

**文件：**

- 修改：`packages/prompts/src/index.ts`
- 修改：`packages/prompts/src/prompt-segments-assembly.ts`
- 测试：`packages/prompts/src/index.test.ts`
- 测试：`packages/prompts/src/ledger-segments.test.ts`

- [ ] **步骤 1：编写失败的扁平提示词测试**

在 `packages/prompts/src/index.test.ts` 的 `buildRuntimeSystemPrompt` 测试组增加两个测试：默认运行时提示词包含 `# Markdown Presentation`，传入 `includeMarkdownPresentation: false` 后不包含该标题。

```ts
it("includes the Markdown presentation policy by default", async () => {
  const prompt = await buildRuntimeSystemPrompt({ cwd: emptyDir });
  expect(prompt).toContain("# Markdown Presentation");
  expect(prompt).toContain(
    "Use tables only when repeated fields benefit from comparison",
  );
});

it("can omit the Markdown presentation policy", async () => {
  const prompt = await buildRuntimeSystemPrompt({
    cwd: emptyDir,
    includeMarkdownPresentation: false,
  });
  expect(prompt).not.toContain("# Markdown Presentation");
});
```

- [ ] **步骤 2：编写失败的分层测试**

在 `packages/prompts/src/ledger-segments.test.ts` 调用默认 `buildTaggedPromptSegments`，确认标题所在分段为 `layer: "stable"`、`bucket: "system"`，且只出现一次。

```ts
const presentation = tagged.filter((segment) =>
  segment.text.includes("# Markdown Presentation"),
);
expect(presentation).toHaveLength(1);
expect(presentation[0]).toMatchObject({ layer: "stable", bucket: "system" });
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```powershell
pnpm --filter @vykor/prompts test -- src/index.test.ts src/ledger-segments.test.ts
```

预期：FAIL；默认提示词没有 `# Markdown Presentation`，并且 TypeScript 尚不接受 `includeMarkdownPresentation`。

- [ ] **步骤 4：实现表达规范纯函数和关闭选项**

在 `packages/prompts/src/index.ts` 增加并导出：

```ts
export function buildMarkdownPresentationSection(): string {
  return `# Markdown Presentation

- Lead with the outcome, then provide only the explanation needed.
- Prefer short paragraphs for simple answers. Do not add headings or lists by default.
- Use flat lists only for genuinely parallel items, steps, options, or comparisons.
- Use only a few major sections for complex answers; do not turn every point into a heading.
- Use tables only when repeated fields benefit from comparison. Put long explanations in prose or lists.
- Use descriptive link text instead of placing long raw URLs on separate lines.
- Use blockquotes only for a genuinely distinct note or warning, not as decoration for every item.
- Follow an explicit format requested by the user or required for a skill's deliverable.`;
}
```

给 `buildRuntimeSystemPrompt`、`buildPromptLayers` 的选项类型以及 `PromptSegmentsAssemblyOptions` 增加：

```ts
includeMarkdownPresentation?: boolean
```

在 `buildTaggedPromptSegments` 的基础行为规则之后保留唯一调用点：

```ts
if (options.includeMarkdownPresentation !== false) {
  pushSegment(segments, "stable", "system", buildMarkdownPresentationSection());
}
```

- [ ] **步骤 5：运行 prompts 测试并确认通过**

运行：

```powershell
pnpm --filter @vykor/prompts test -- src/index.test.ts src/ledger-segments.test.ts
```

预期：相关测试全部 PASS。

- [ ] **步骤 6：提交提示词规范**

```powershell
git add -- packages/prompts/src/index.ts packages/prompts/src/prompt-segments-assembly.ts packages/prompts/src/index.test.ts packages/prompts/src/ledger-segments.test.ts
git commit -m "feat(prompts): guide compact markdown responses"
```

### 任务 2：收紧桌面对话正文排版

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 测试：`apps/desktop/src/renderer/src/markdown-table-styles.test.ts`

- [ ] **步骤 1：扩展失败的样式回归测试**

把测试文件读取的资源扩展到 `conversation-page.tsx`，断言消息滚动内容使用 `max-w-190`；同时断言助手消息专用规则包含以下值：

```ts
expect(conversationPage).toContain("max-w-190");
expect(stylesheet).toMatch(
  /\.assistant-markdown \[data-streamdown="list-item"\]\s*\{[^}]*padding-block:\s*0;/s,
);
expect(stylesheet).toMatch(
  /\.assistant-markdown \[data-streamdown="blockquote"\]\s*\{[^}]*margin:\s*0\.6rem 0;/s,
);
expect(stylesheet).toMatch(
  /\.assistant-markdown \[data-streamdown="link"\]\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
);
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/markdown-table-styles.test.ts
```

预期：FAIL；正文仍是 `max-w-190`，且不存在助手消息专用覆盖。

- [ ] **步骤 3：拓宽消息正文**

在 `conversation-page.tsx` 只把 `MessageScrollerContent` 的 `max-w-190` 改为 `max-w-190`。不要修改 `NewConversationStart`、输入框、浮层或 Markdown 文件预览的宽度。

- [ ] **步骤 4：增加助手消息专用样式**

在 `main.css` 的通用 Streamdown 规则之后增加 `.assistant-markdown` 前缀的覆盖：

```css
.assistant-markdown [data-streamdown="heading-1"] {
  margin-block: 0.45rem 0.4rem;
}

.assistant-markdown [data-streamdown="heading-2"] {
  margin-block: 1rem 0.35rem;
}

.assistant-markdown [data-streamdown="heading-3"] {
  margin-block: 0.8rem 0.3rem;
}

.assistant-markdown [data-streamdown="list-item"] {
  padding-block: 0;
}

.assistant-markdown [data-streamdown="blockquote"] {
  margin: 0.6rem 0;
  padding-block: 0.15rem;
}

.assistant-markdown [data-streamdown="paragraph"] {
  margin-block: 0;
}

.assistant-markdown [data-streamdown="link"] {
  color: var(--file-link);
  overflow-wrap: anywhere;
}
```

保留现有表格样式，不修改 `.desktop-markdown-preview` 的布局。

- [ ] **步骤 5：运行桌面样式测试并确认通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/markdown-table-styles.test.ts
```

预期：测试文件全部 PASS。

- [ ] **步骤 6：提交正文排版**

```powershell
git add -- apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/markdown-table-styles.test.ts
git commit -m "fix(desktop): tighten assistant markdown layout"
```

### 任务 3：完成整体验证

**文件：**

- 验证：任务 1 和任务 2 的全部修改

- [ ] **步骤 1：运行定向测试**

```powershell
pnpm --filter @vykor/prompts test -- src/index.test.ts src/ledger-segments.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/markdown-table-styles.test.ts
```

预期：全部 PASS，无未处理异常。

- [ ] **步骤 2：运行格式检查**

```powershell
pnpm --filter @vykor/prompts exec prettier --check src/index.ts src/prompt-segments-assembly.ts src/index.test.ts src/ledger-segments.test.ts
pnpm --filter @vykor/desktop exec prettier --check src/renderer/src/components/desktop/conversation-page/conversation-page.tsx src/renderer/src/assets/main.css src/renderer/src/markdown-table-styles.test.ts
git diff --check
```

预期：全部命令退出码为 0。

- [ ] **步骤 3：运行全仓类型检查**

```powershell
pnpm check-types
```

预期：Turbo 报告全部任务成功。

- [ ] **步骤 4：核对范围与仓库状态**

```powershell
git diff --stat HEAD~2..HEAD
git status --short
```

预期：只有计划列出的 VK 提示词、桌面对话样式和测试文件发生变化；第三方技能目录无变化；工作区干净。
