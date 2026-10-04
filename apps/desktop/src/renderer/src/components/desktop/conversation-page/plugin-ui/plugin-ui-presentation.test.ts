import { expect, it } from "vitest"
import { buildAssistantContent } from "../message/message-render-model"
import { instance, sourcePart } from "./plugin-ui-fixtures.test-support"
it("keeps the trusted source outside ordinary tool groups without losing its result", () => {
  const units = buildAssistantContent([sourcePart])
  expect(units).toHaveLength(1)
  expect(units[0]).toMatchObject({ type: "plugin-ui", instance, call: sourcePart })
  expect((units[0] as { call: typeof sourcePart }).call.output).toEqual(sourcePart.output)
})
it("rejects proposals, wrong source identity and business action tools as UI sources", () => {
  for (const metadata of [
    { pluginUi: { schemaVersion: 1, componentId: "card", data: {} } },
    { pluginUi: { ...instance, sourcePartId: "another" } },
    { uiAction: { instanceId: instance.instanceId } },
  ])
    expect(buildAssistantContent([{ ...sourcePart, metadata }])[0]?.type).toBe("tool")
})
