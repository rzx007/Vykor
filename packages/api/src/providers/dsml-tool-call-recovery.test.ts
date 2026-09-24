import { describe, it, expect } from "vitest";
import {
  createDsmlRecoveryScanner,
  type RecoveredToolCall,
} from "./dsml-tool-call-recovery.js";

const BAR = "\uFF5C";

function tag(name: string): string {
  return `<${BAR}DSML${BAR}${name}>`;
}

function openTag(name: string, attrs: string): string {
  return `<${BAR}DSML${BAR}${name} ${attrs}>`;
}

function closeTag(name: string): string {
  return `</${BAR}DSML${BAR}${name}>`;
}

interface ScanOutcome {
  visible: string;
  calls: RecoveredToolCall[];
}

function scan(chunks: string[], declared: readonly string[] = ["Read", "Write"]): ScanOutcome {
  const scanner = createDsmlRecoveryScanner({ declaredToolNames: new Set(declared) });
  const visible: string[] = [];
  const calls: RecoveredToolCall[] = [];
  for (const chunk of chunks) {
    const result = scanner.push(chunk);
    visible.push(result.visible);
    calls.push(...result.toolCalls);
  }
  const tail = scanner.flush();
  visible.push(tail.visible);
  calls.push(...tail.toolCalls);
  return { visible: visible.join(""), calls };
}

function readBlock(filePath: string): string {
  return [
    tag("tool_calls"),
    openTag("invoke", 'name="Read"'),
    openTag("parameter", 'name="file_path" string="true"') + filePath + closeTag("parameter"),
    closeTag("invoke"),
    closeTag("tool_calls"),
  ].join(" ");
}

describe("createDsmlRecoveryScanner", () => {
  it("recovers a wrapped invoke block and hides the markup", () => {
    const outcome = scan([`先确认模板结构。\n${readBlock("C:\\tmp\\a.json")}`]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.name).toBe("Read");
    expect(outcome.calls[0]!.input).toEqual({ file_path: "C:\\tmp\\a.json" });
    expect(outcome.visible).toBe("先确认模板结构。\n");
  });

  it("recovers an orphan invoke block when the tool_calls wrapper is missing", () => {
    const orphan = [
      openTag("invoke", 'name="Read"'),
      openTag("parameter", 'name="file_path" string="true"') + "C:\\tmp\\pages.json" + closeTag("parameter"),
      closeTag("invoke"),
    ].join(" ");
    const outcome = scan([`看下页面配置\n${orphan}`]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({ file_path: "C:\\tmp\\pages.json" });
    expect(outcome.visible).toBe("看下页面配置\n");
  });

  it("parses the real compact single-line leak captured from DeepSeek-V4-Flash", () => {
    const leaked = String.raw`环境正常。模板结构确认：{{ROOT}} 指向 skill 根目录。

现在确认引擎对 data-page 的 page 类型 id、data-id 用法、以及 data-enter 进场动画的取值。

<｜DSML｜tool_calls> <｜DSML｜invoke name="Read"> <｜DSML｜parameter name="file_path" string="true">C:\Users\ruanz\.agents\skills\orca-ppt\runtime\pages.json</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls>`;
    const outcome = scan([leaked]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({
      file_path: String.raw`C:\Users\ruanz\.agents\skills\orca-ppt\runtime\pages.json`,
    });
    expect(outcome.visible).not.toContain("DSML");
    expect(outcome.visible.endsWith("取值。\n\n")).toBe(true);
  });

  it("never leaks partial markup when the block is split across chunks", () => {
    const full = `前<junk>文${readBlock("C:\\tmp\\a.json")}后文`;

    for (let size = 1; size <= full.length; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
      const outcome = scan(chunks);

      expect(outcome.calls, `chunk size ${size}`).toHaveLength(1);
      expect(outcome.visible, `chunk size ${size}`).toBe("前<junk>文后文");
    }
  });

  it("recovers ASCII-pipe marker variants", () => {
    const leaked = [
      "<|DSML|tool_calls>",
      '<|DSML|invoke name="Read">',
      '<|DSML|parameter name="file_path" string="true">a.json</|DSML|parameter>',
      "</|DSML|invoke>",
      "</|DSML|tool_calls>",
    ].join("\n");
    const outcome = scan([leaked]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({ file_path: "a.json" });
    expect(outcome.visible).toBe("");
  });

  it("recovers spaced degraded markers", () => {
    const leaked =
      '< | DSML | tool_calls >\n< | DSML | invoke name="Read" >< | DSML | parameter name="file_path" string="true" >a.json</ | DSML | parameter ></ | DSML | invoke >';
    const outcome = scan([leaked]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({ file_path: "a.json" });
    expect(outcome.visible).toBe("");
  });

  it("recovers the doubled-pipe calls wrapper emitted by DeepSeek", () => {
    const leaked = String.raw`< | | DSML | | calls> < | | DSML | | invoke name="Shell"> < | | DSML | | parameter name="command" string="true">Get-Content "$env:USERPROFILE\.vykor\settings.json"</ | | DSML | | parameter> </ | | DSML | | calls>`;
    const outcome = scan([...leaked], ["Shell"]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({
      command: String.raw`Get-Content "$env:USERPROFILE\.vykor\settings.json"`,
    });
    expect(outcome.visible).toBe("");
  });

  it("removes markdown escapes from leaked parameter names and closing tags", () => {
    const leaked = String.raw`<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="Edit"> <｜｜DSML｜｜ parameter name="file\_path" string="true">C:\tmp\styles.css\</｜｜DSML｜｜ parameter> <｜｜DSML｜｜ parameter name="new\_string" string="true">.card {}\</｜｜DSML｜｜ parameter> <｜｜DSML｜｜ parameter name="old\_string" string="true">/* APPEND:05 */\</｜｜DSML｜｜ parameter> \</｜｜DSML｜｜ invoke> \</｜｜DSML｜｜ calls>`;
    const outcome = scan([...leaked], ["Edit"]);

    expect(outcome.calls).toEqual([{
      id: "dsml_0",
      name: "Edit",
      input: {
        file_path: String.raw`C:\tmp\styles.css`,
        new_string: ".card {}",
        old_string: "/* APPEND:05 */",
      },
    }]);
    expect(outcome.visible).toBe("");
  });

  it("closes a parameter when the model writes a bare DSML close tag", () => {
    const body = [
      openTag("invoke", 'name="Write"'),
      openTag("parameter", 'name="file_path" string="true"') + `a.txt</${BAR}DSML${BAR}>`,
      openTag("parameter", 'name="content" string="true"') + "hello" + closeTag("parameter"),
      closeTag("invoke"),
    ].join("");
    const outcome = scan([body]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.input).toEqual({ file_path: "a.txt", content: "hello" });
  });

  it("recovers multiple invoke blocks in one stream", () => {
    const outcome = scan([
      readBlock("a.json"),
      "\n中间说明\n",
      readBlock("b.json"),
    ]);

    expect(outcome.calls.map((call) => call.input.file_path)).toEqual(["a.json", "b.json"]);
    expect(outcome.calls[0]!.id).not.toBe(outcome.calls[1]!.id);
    expect(outcome.visible).toBe("\n中间说明\n");
  });

  it("releases the block unchanged when the tool name is not declared", () => {
    const leaked = [
      openTag("invoke", 'name="Unknown"'),
      openTag("parameter", 'name="x" string="true"') + "1" + closeTag("parameter"),
      closeTag("invoke"),
    ].join("");
    const outcome = scan([leaked]);

    expect(outcome.calls).toHaveLength(0);
    expect(outcome.visible).toBe(leaked);
  });

  it("does not swallow text when the stream ends mid-block", () => {
    const truncated = `残留开头${openTag("invoke", 'name="Read"')} ${openTag("parameter", 'name="file_path" string="true"')}C:\\tmp`;
    const outcome = scan([truncated]);

    expect(outcome.calls).toHaveLength(0);
    expect(outcome.visible).toBe(truncated);
  });

  it("leaves ordinary prose containing angle brackets untouched", () => {
    const text = "if a < b and <div>hi</div>, then 1 < 2";
    const outcome = scan([text]);

    expect(outcome.calls).toHaveLength(0);
    expect(outcome.visible).toBe(text);
  });

  it("recovers a call that declares no parameters", () => {
    const outcome = scan([
      `先看状态${openTag("invoke", 'name="Read"')}${closeTag("invoke")}然后继续`,
    ]);

    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.name).toBe("Read");
    expect(outcome.calls[0]!.input).toEqual({});
    expect(outcome.visible).toBe("先看状态然后继续");
  });

  it("keeps JSON parameters typed and string parameters literal", () => {
    const body = [
      openTag("invoke", 'name="Write"'),
      openTag("parameter", 'name="count"') + "5" + closeTag("parameter"),
      openTag("parameter", 'name="payload"') + '{"a":1}' + closeTag("parameter"),
      openTag("parameter", 'name="text" string="true"') + '{"a":1}' + closeTag("parameter"),
      closeTag("invoke"),
    ].join("");
    const outcome = scan([body]);

    expect(outcome.calls[0]!.input).toEqual({ count: 5, payload: { a: 1 }, text: '{"a":1}' });
  });

  it("falls back to the raw string when a non-string parameter is not valid JSON", () => {
    const body = [
      openTag("invoke", 'name="Write"'),
      openTag("parameter", 'name="content"') + "not json at all" + closeTag("parameter"),
      closeTag("invoke"),
    ].join("");
    const outcome = scan([body]);

    expect(outcome.calls[0]!.input).toEqual({ content: "not json at all" });
  });

  it("does not recover anything when no tool names are declared", () => {
    const leaked = readBlock("a.json");
    const outcome = scan([leaked], []);

    expect(outcome.calls).toHaveLength(0);
    expect(outcome.visible).toBe(leaked);
  });
});
