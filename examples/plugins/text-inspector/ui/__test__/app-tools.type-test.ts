import { App } from "@modelcontextprotocol/ext-apps";
import { createPluginAppClient } from "../app-client.mjs";
import { textInspectorTools } from "../../tools/app-tools.mjs";

const app = new App({ name: "type-check", version: "1.0.0" });
const tools = createPluginAppClient(app);
async function checkTypes() {
  const result = await tools.call(textInspectorTools.check, { text: "hello " }, { signal: new AbortController().signal });
  const code: "tab-indentation" | "trailing-whitespace" | undefined = result.structuredContent?.findings[0]?.code;
  const text: string | undefined = result.structuredContent?.text;
  void [code, text, result.content, result.isError, result._meta];
  await tools.call(textInspectorTools.preview, { text: "hello ", selected: ["1:trailing-whitespace"] });
  // @ts-expect-error The shared definition requires selected findings for a preview.
  await tools.call(textInspectorTools.preview, { text: "hello " });
  // @ts-expect-error Selected findings are IDs, not numbers.
  await tools.call(textInspectorTools.preview, { text: "hello ", selected: [1] });
  // @ts-expect-error The real SDK's cancellation option is preserved.
  await tools.call(textInspectorTools.check, { text: "hello " }, { signal: "cancel" });
}
void checkTypes;
