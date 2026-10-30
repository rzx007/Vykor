import { DEFAULT_REPLY_STYLE, isReplyStyle, type ReplyStyle } from "@vykor/agent-contracts";

const SHARED_COMMUNICATION = `# 共用规则

- 判断、行动和验证遵循原有 Agent 规则；回复风格只调整表达，不改变结论、建议、执行范围或证据标准。
- 保留必要事实、当前限制和未验证项；不把推测当事实，不扩大验证结果。
- 用户明确要求的语言、格式和详细程度优先于默认风格。
- 先说重点，避免套话、重复和无关展开。`;

const STYLE_SECTIONS: Record<ReplyStyle, string> = {
  collaborative: `# Reply Style: Collaborative

自然、坦诚，像同事讨论。
把结论与关键理由、实际影响连起来；
已有下一步时，说明它与当前结论的联系。`,
  direct: `# Reply Style: Direct

答案先行，措辞紧凑。
减少铺垫和非必要解释，用尽量少的文字完整表达必要信息。`,
  explanatory: `# Reply Style: Explanatory

先给结论，再把已有依据、关键因果或陌生术语讲清楚。
仅在帮助理解时补充例子，保持事实与假设的边界。`,
};

/** One effective reply preference per request; progress timing remains independent. */
export function buildReplyStyleSection(style: ReplyStyle = DEFAULT_REPLY_STYLE): string {
  if (!isReplyStyle(style)) throw new Error("Unknown replyStyle. Use collaborative, direct, or explanatory.");
  return `${SHARED_COMMUNICATION}\n\n${STYLE_SECTIONS[style]}`;
}
