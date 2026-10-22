export const sampleData = {
  "project": {
    "id": "media-demo-project",
    "name": "产品发布项目",
    "path": "C:\\Vykor Demo\\product-launch",
    "lastOpenedAt": 1792540800000,
    "available": true
  },
  "fileContents": {
    "src/LaunchPage.tsx": "import { useState } from \"react\"\n\nconst sections = [\"产品\", \"使用方式\", \"文档\"]\n\nexport function LaunchPage() {\n  const [active, setActive] = useState(\"产品\")\n\n  return (\n    <main className=\"launch-page\">\n      <nav aria-label=\"主导航\">\n        <a href=\"/\">Vykor</a>\n        {sections.map((section) => (\n          <button\n            key={section}\n            aria-pressed={active === section}\n            onClick={() => setActive(section)}\n          >\n            {section}\n          </button>\n        ))}\n      </nav>\n\n      <section aria-labelledby=\"hero-title\">\n        <h1 id=\"hero-title\">你的 AI 工作台</h1>\n        <p>与 AI 一起写代码、查资料、整理文档。</p>\n        <a href=\"/download\">下载 Vykor</a>\n      </section>\n    </main>\n  )\n}",
    "docs/参考资料.md": "# 官网动效参考\n\n## 已保存的原始资料\n\n| 来源 | 本次关注的内容 |\n| --- | --- |\n| ego(lite) 首页 | 镜片特写与产品窗口的交接 |\n| Three.js 文档 | 三维模型、透射材质与动画时间 |\n| GSAP 文档 | 滚动位置与动画进度的连接 |\n\n## 对 Vykor 的启发\n\n保留自己的括号与机器人标识，把它做成有厚度的三维物件。\n\n镜片退出后，让真实的产品界面成为视觉中心。\n\n## 来源链接\n\n- https://lite.ego.app/zh-cn\n- https://threejs.org/docs/\n- https://gsap.com/docs/v3/Plugins/ScrollTrigger/\n\n> 这是一份用于产品素材的示例资料，不是自动调研能力的验证报告。",
    "docs/上线说明.md": "# Vykor 官网 · 上线说明草稿\n\n## 页面内容\n\n首屏介绍 AI 工作台，随后展示编程、调研和文档场景。\n\n## 待接入的资源\n\n- Vykor 原创三维标识\n- 工作台与文件预览素材\n- 实际发布渠道对应的下载链接\n\n## 交互要求\n\n镜片动画随滚动前进或返回。\n\n停止滚动后，画面尽快稳定。\n\n移动端使用更短的交接过程，保留完整文案和下载入口。\n\n## 发布前检查\n\n- [ ] 下载链接可用\n- [ ] 键盘可以操作主要入口\n- [ ] 减少动态效果模式可阅读\n- [ ] 用实际产品素材替换所有占位内容\n\n> 这是一份用于官网素材制作的示例文档。"
  },
  "scenarios": [
    {
      "id": "workspace",
      "title": "准备产品发布页",
      "prompt": "示例任务：为这个产品准备一个首页，整理参考资料和上线说明。",
      "text": "可以把这件事留在同一个项目里推进。\n\n先整理参考资料，确定页面要讲清楚的内容；接着实现首页，最后把资源与发布检查项收进文档。\n\n### 工作资料\n\n- `src/LaunchPage.tsx`：首页界面\n- `docs/参考资料.md`：参考页面与来源\n- `docs/上线说明.md`：发布前的检查项\n\n你可以在右侧打开这些文件，继续修改。",
      "file": null
    },
    {
      "id": "coding",
      "title": "实现产品首页",
      "prompt": "示例任务：实现产品首页，保留清晰的导航，并适配手机。",
      "text": "首页的界面片段放在 `src/LaunchPage.tsx`。\n\n主标题直接说明产品用途，导航与下载入口各自保持清晰。右侧可以查看实现细节。\n\n### 继续处理\n\n- 连接实际下载地址\n- 接入三维品牌素材\n- 在手机宽度下检查文字与导航\n\n这段示例保留了待办项，没有附加未经执行的测试结论。",
      "file": "src/LaunchPage.tsx"
    },
    {
      "id": "research",
      "title": "整理官网参考资料",
      "prompt": "示例任务：整理官网动效的参考资料，并保留原始来源。",
      "text": "资料按本次设计需要整理成了三个部分：\n\n| 资料 | 用途 |\n| --- | --- |\n| ego(lite) 首页 | 观察镜片怎样交接到产品窗口 |\n| Three.js | 确认模型、材质和动画的实现方式 |\n| ScrollTrigger | 连接滚动位置与动画进度 |\n\n笔记和来源放在 `docs/参考资料.md`，可以继续补充观察。",
      "file": "docs/参考资料.md"
    },
    {
      "id": "document",
      "title": "继续完善上线说明",
      "prompt": "示例任务：回到之前的发布项目，继续整理上线说明。",
      "text": "上次的资料和文件仍在这个项目里。\n\n`docs/上线说明.md` 保留了页面内容、素材列表和发布检查项。下载地址等尚未确定的内容继续标为待接入。\n\n你可以直接修改右侧文档，也可以补充新的要求。",
      "file": "docs/上线说明.md"
    }
  ]
}

