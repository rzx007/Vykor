import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReferences } from "./check-retired-native-ui.mjs";

test("each historical approval is exact and does not hide a new live entry in the same file", () => {
  const source = 'const history = readPluginUiInstance(record);';
  const approved = [{ path: "history.ts", line: 1, text: source, reason: "Read original historical record" }];
  assert.deepEqual(verifyReferences([{ path: "history.ts", source }], approved), []);
  assert.match(verifyReferences([{ path: "history.ts", source: source + '\ncreatePluginUiClient();' }], approved).join(), /Unreviewed/);
  assert.match(verifyReferences([{ path: "history.ts", source: 'createPluginUiClient();' }], approved).join(), /Unreviewed/);
  assert.match(verifyReferences([], approved).join(), /Stale approval/);
});
