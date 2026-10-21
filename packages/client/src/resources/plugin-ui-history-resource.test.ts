import { expect, it, vi } from "vitest";
import { PluginUiHistoryResource } from "./plugin-ui-history-resource.js";
it("exposes only original read-only history addresses", async () => {
  const request = vi.fn(async () => ({ receipt: { kind: "conversation", mode: "submit", instanceId: "10000000-0000-4000-8000-000000000001", revision: 1,
    requestId: "20000000-0000-4000-8000-000000000001", inputId: "input", runId: "run", status: "completed" } }));
  const history = new PluginUiHistoryResource({ request } as never);
  const id = "10000000-0000-4000-8000-000000000001", rid = "20000000-0000-4000-8000-000000000001";
  await history.getAction("s", id, rid);
  await history.getConversationSubmission("s", id, rid);
  expect(request.mock.calls.map(call => call[0])).toEqual([`/sessions/s/plugin-ui/${id}/actions/${rid}`, `/sessions/s/plugin-ui/${id}/conversation/submissions/${rid}`]);
  for (const name of ["invokeAction", "getDocument", "dismiss", "prepareConversation", "submitConversation", "get"]) expect(history).not.toHaveProperty(name);
});
