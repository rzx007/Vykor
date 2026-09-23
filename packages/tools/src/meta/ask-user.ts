import type { ToolDefinition } from "@openharness/core";

export const askUserTool: ToolDefinition = {
  name: "AskUser",
  description: "Ask the interactive user a follow-up question and return the answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      questions: {
        type: "array",
        description: "Optional sequence of questions shown one at a time",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["question"],
        },
      },
    },
    required: [],
  },
  async execute(input, context) {
    const askFn = context.askUserPrompt as
      | ((q: string) => Promise<string>)
      | undefined;
    if (!askFn) {
      return {
        content: [{ type: "text", text: "ask_user_question is unavailable in this session" }],
        isError: true,
      };
    }
    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (input.questions !== undefined && !Array.isArray(input.questions)) {
      return { content: [{ type: "text", text: "AskUser questions must be an array" }], isError: true };
    }
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const record = item as Record<string, unknown>;
      return typeof record.question !== "string" || !record.question.trim() ||
        (record.options !== undefined &&
          (!Array.isArray(record.options) || record.options.some((option) => typeof option !== "string")));
    })) {
      return { content: [{ type: "text", text: "AskUser contains an invalid question" }], isError: true };
    }
    if (!question && questions.length === 0) {
      return { content: [{ type: "text", text: "AskUser requires question or questions" }], isError: true };
    }
    const prompt = questions.length > 0
      ? JSON.stringify({ kind: "question", questions })
      : question;
    const answer = (await askFn(prompt)).trim();
    return { content: [{ type: "text", text: answer || "(no response)" }] };
  },
};
