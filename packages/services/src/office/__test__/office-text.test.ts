import { expect, it } from "vitest";
import { wordParagraphText, assertCompleteOfficeText } from "../office-text.js";

it("keeps body and table paragraphs in order with exact cell paths and no duplicate runs", () => {
  const nodes = [
    {
      type: "paragraph",
      path: "/body/p[1]",
      text: "正文开头",
      children: [{ text: "正文开头" }],
    },
    {
      type: "paragraph",
      path: "/body/tbl[1]/tr[2]/tc[2]/p[1]",
      text: "周宁 731",
    },
    {
      type: "paragraph",
      path: "/body/tbl[1]/tr[2]/tc[2]/p[2]",
      text: "第二段陈禾",
    },
    {
      type: "paragraph",
      path: "/body/tbl[1]/tr[2]/tc[2]/tbl[1]/tr[1]/tc[1]/p[1]",
      text: "嵌套单元格",
    },
    { type: "paragraph", path: "/body/p[2]", text: "正文结尾" },
  ];
  const text = wordParagraphText(
    JSON.stringify({
      success: true,
      data: { matches: nodes.length, results: nodes },
    }),
  );
  expect(text.split("\n")).toHaveLength(5);
  expect(text).toContain("[/body/tbl[1]/tr[2]/tc[2]/p[1]] 周宁 731");
  expect(text.indexOf("周宁")).toBeLessThan(text.indexOf("正文结尾"));
  expect(text.match(/正文开头/g)).toHaveLength(1);
  expect(text).toContain("嵌套单元格");
});
it("rejects incomplete and failed paragraph queries", () => {
  expect(() =>
    wordParagraphText(
      JSON.stringify({ success: true, data: { matches: 2, results: [] } }),
    ),
  ).toThrow("不完整");
  expect(() => wordParagraphText(JSON.stringify({ success: false }))).toThrow(
    "不完整",
  );
  expect(() =>
    wordParagraphText(
      JSON.stringify({
        success: true,
        data: {
          matches: 1,
          results: [{ type: "paragraph", text: "missing path" }],
        },
      }),
    ),
  ).toThrow("无效");
});
it("rejects the real OfficeCLI truncation footer instead of returning partial text", () => {
  expect(() =>
    assertCompleteOfficeText(
      "A1=1\n... (showed 1 rows, 10 total, use --start/--end to view more)",
    ),
  ).toThrow("截断");
  expect(assertCompleteOfficeText("A1=1\nB1=2")).toBe("A1=1\nB1=2");
});
