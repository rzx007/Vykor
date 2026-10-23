import { App } from "@modelcontextprotocol/ext-apps";
import { createPluginAppClient } from "../app-client.mjs";
import { noteTools } from "../../src/app-tools.mjs";

const tools = createPluginAppClient(new App({ name: "notes-type-check", version: "1.0.0" }));
async function checkTypes() {
  const result = await tools.call(noteTools.save, { expectedRevision: 0, operationId: "save-1", text: "draft" });
  const revision: number | undefined = result.structuredContent?.revision;
  const saved: boolean | undefined = result.structuredContent?.saved;
  void [revision, saved];
  // @ts-expect-error A save needs the original revision and operation ID.
  await tools.call(noteTools.save, { text: "draft" });
  // @ts-expect-error Save revisions are numeric.
  await tools.call(noteTools.save, { expectedRevision: "0", operationId: "save-1", text: "draft" });
}
void checkTypes;
