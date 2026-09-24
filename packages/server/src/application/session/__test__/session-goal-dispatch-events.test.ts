import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "@vykor/services";

import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { ApplicationEventService } from "../../events/application-event-service.js";
import { SessionEventPublisher } from "../session-event-publisher.js";
import { SessionGoalService } from "../session-goal-service.js";
import { SessionOperationRunner } from "../session-operation-runner.js";

describe("SessionGoalService dispatch event boundary", () => {
  it("publishes committed Goal events when dispatch fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-dispatch-events-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      store.sessions.create({
        id: "s1",
        cwd: process.cwd(),
        model: "test-model",
      });
      const eventService = new ApplicationEventService(store.conversations);
      const publisher = new SessionEventPublisher(store.conversations, eventService);
      const operationRunner = new SessionOperationRunner({
        sessions: store.sessions,
        operationGate: new DaemonOperationGate(),
        events: publisher,
      });
      const admission = {
        persistGoalRun: (sessionId: string, input: any) =>
          store.conversationTransactions.admitPromptWithRun({
            prompt: {
              id: input.id,
              sessionId,
              delivery: "queue",
              items: input.items,
              attachments: input.attachments ?? [],
              metadata: input.metadata,
            },
            run: { metadata: input.runMetadata },
          }),
        dispatchPersistedRun: () => {
          throw new Error("dispatch unavailable");
        },
      };
      const control = {
        cancelGoalRuns: () => [],
        waitForRuns: async () => undefined,
        hasUserWork: () => false,
      };
      const service = new SessionGoalService({
        transaction: store,
        sessions: store.sessions,
        runs: store.runs,
        conversations: store.conversations,
        permissions: store.permissions,
        goals: store.goals,
        operationRunner,
        admission,
        control,
        events: publisher,
        pluginCapabilities: { admit: async () => ({}) },
      });
      const controller = new AbortController();
      const iterator = eventService
        .subscribe({ after: store.conversations.latestEventSeq(), signal: controller.signal })
        .stream[Symbol.asyncIterator]();
      const nextEvent = iterator.next();

      await expect(
        service.create("s1", {
          requestId: "goal-create",
          objective: "persist before dispatch",
        }),
      ).rejects.toThrow("dispatch unavailable");

      const received = await Promise.race([
        nextEvent,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(received).toMatchObject({
        value: { type: "session.goal.created", sessionId: "s1" },
        done: false,
      });
      expect(store.goals.getCurrentGoal("s1")).toMatchObject({ status: "active" });
      expect(store.goals.getGoalRequest("goal-create")).toMatchObject({ status: "pending" });

      controller.abort();
      await iterator.return?.();
      eventService.close();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
