import { describe, expect, it } from "vitest";
import type { StreamingMessageClient, ToolDefinition } from "@vykor/core";
import { behaviorCases, type BehaviorCase } from "./cases.js";
import { runBehaviorCase } from "./run.js";

const options = { model: "scripted", revision: "catalog-v1", repeat: 1, maxRequests: 5, timeoutMs: 10_000 };

function catalog(size: number): ToolDefinition[] {
  return Array.from({ length: size }, (_, index) => ({
    name: `InspectSource_${String(index).padStart(3, "0")}`,
    description: `Inspect source ${index} and return its evidence`,
    inputSchema: { type: "object", properties: { source: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text" as const, text: `evidence ${index}` }] }),
  }));
}

function scenario(size: number): BehaviorCase {
  return { id: `catalog-${size}`, domain: "research", prompt: "Inspect the first two sources", setup: () => ({
    tools: catalog(size), deniedTools: [`InspectSource_${String(size - 1).padStart(3, "0")}`],
    verify: ({ events }) => {
      const passed = [0, 1].every((index) => {
        const name = `InspectSource_${String(index).padStart(3, "0")}`;
        const started = events.filter((event) => event.type === "tool.started")
          .find((event) => event.data.toolUse.name === name);
        return started && events.some((event) => event.type === "tool.completed" &&
          event.data.toolUseId === started.data.toolUse.id &&
          event.data.result.content.some((part) => part.type === "text" && part.text === `evidence ${index}`));
      });
      return { passed: Boolean(passed), reason: passed ? "both sources inspected" : "required source evidence missing" };
    },
  }) };
}

describe("tool catalog measurement", () => {
  it.each([0, 1])("does not pass when only %i required sources are inspected", async (calls) => {
    let request = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      if (request++ === 0 && calls === 1) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "source-0", name: "InspectSource_000", input: {} } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else {
        yield { type: "complete" as const, stopReason: "end_turn" };
      }
    } };
    const result = await runBehaviorCase(scenario(8), { ...options, client });

    expect(result.toolCalls).toBe(calls);
    expect(result.status).toBe("failed");
  });

  it.each([4, 8, 40, 120])("measures the %i-tool catalog actually sent to the provider", async (size) => {
    const sent: Array<NonNullable<Parameters<StreamingMessageClient["streamMessage"]>[0]["tools"]>> = [];
    let request = 0;
    const client: StreamingMessageClient = { async *streamMessage(params) {
      sent.push(params.tools ?? []);
      yield { type: "usage" as const, usage: { inputTokens: 10_000, outputTokens: 25 } };
      if (request++ === 0) {
        for (const index of [0, 1]) {
          yield { type: "tool_use_start" as const, toolUse: {
            type: "tool_use" as const, id: `source-${index}`, name: `InspectSource_00${index}`, input: {},
          } };
        }
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else {
        yield { type: "complete" as const, stopReason: "end_turn" };
      }
    } };
    const result = await runBehaviorCase(scenario(size), { ...options, client });

    expect(result.status).toBe("passed");
    expect(result.toolCalls).toBe(2);
    expect(sent).toHaveLength(2);
    for (const tools of sent) expect(tools.map((tool) => tool.name)).toEqual(catalog(size).slice(0, -1).map((tool) => tool.name));
    const serializedLength = JSON.stringify(sent[0]).length;
    const requestCatalog = {
      definitionCount: size - 1,
      serializedLength,
      estimatedToolTokens: Math.ceil(serializedLength / 4),
      estimateMethod: "heuristic_v1",
      actualInputTokens: 10_000,
      estimatedToolTokenShareOfActualInput: Math.ceil(serializedLength / 4) / 10_000,
    };
    expect(result.toolCatalogRequests).toEqual([requestCatalog, requestCatalog]);
    expect(result.estimatedToolTokens).toBe(2 * Math.ceil(serializedLength / 4));
    expect(result.actualInputTokens).toBe(20_000);
    if (size === 40) {
      request = 0;
      const repeated = await runBehaviorCase(scenario(size), { ...options, client, repeat: 2 });
      expect(repeated.toolCatalogRequests).toEqual(result.toolCatalogRequests);
      expect(sent[2]?.map((tool) => tool.name)).toEqual(sent[0]?.map((tool) => tool.name));
    }
  });

  it("records each request separately and leaves absent usage unknown", async () => {
    let request = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      request++;
      if (request === 1) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "wrong-1", name: "InspectSource_002", input: {} } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else {
        yield { type: "complete" as const, stopReason: "end_turn" };
      }
    } };
    const result = await runBehaviorCase(scenario(8), {
      ...options, client, relevantToolNames: ["InspectSource_000", "InspectSource_001"],
    });

    expect(result.requestCount).toBe(2);
    expect(result.toolCatalogRequests).toHaveLength(2);
    expect(result.toolCatalogRequests![0]).toEqual(result.toolCatalogRequests![1]);
    expect(result.toolCatalogRequests![0]).not.toHaveProperty("actualInputTokens");
    expect(result.toolCatalogRequests![0]).not.toHaveProperty("estimatedToolTokenShareOfActualInput");
    expect(result.toolSelectionErrors).toBe(1);
  });

  it("records definition changes across compaction and counts no definitions for a summary request", async () => {
    const item = behaviorCases.find((entry) => entry.id === "J3")!;
    const result = await runBehaviorCase(item, {
      ...options, client: item.scripted!(), maxRequests: 25, timeoutMs: 120_000,
    });

    expect(result.status).toBe("passed");
    const counts = result.toolCatalogRequests!.map((request) => request.definitionCount);
    const summaryIndex = counts.indexOf(0);
    expect(summaryIndex).toBeGreaterThan(0);
    expect(summaryIndex).toBeLessThan(counts.length - 1);
    expect(counts[summaryIndex - 1]).toBeGreaterThan(0);
    expect(counts[summaryIndex + 1]).toBeGreaterThan(0);
    const summary = result.toolCatalogRequests![summaryIndex];
    expect(summary).toMatchObject({ serializedLength: 0, estimatedToolTokens: 0 });
    expect(result.toolCatalogRequests!.filter((request) => request.definitionCount > 0).length).toBeGreaterThan(1);
    expect(result.estimatedToolTokens).toBe(result.toolCatalogRequests!.reduce((sum, request) => sum + request.estimatedToolTokens, 0));
  });
});
