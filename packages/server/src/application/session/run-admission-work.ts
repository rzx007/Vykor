import { randomUUID } from "node:crypto";
import { sessionUserInputText, type SessionUserInputItem } from "@vykor/protocol";
import { AttachmentError, normalizePromptAttachments, promptAttachmentFingerprint } from "@vykor/services";
import { jsonEqual, normalizeTraceId, withoutTraceId } from "../support.js";
import { RunInterruptedError } from "../../runtime/run-coordinator.js";
import type { AdmitPromptInput, AdmitPromptResult, RunAdmissionServiceOptions } from "./run-admission-service.js";

export function inputItems(input: {
  items?: readonly SessionUserInputItem[];
  content?: string;
}): SessionUserInputItem[] {
  return input.items ? [...input.items] : [{ type: "text", text: input.content ?? "" }];
}

export async function admitPromptWork(
  options: RunAdmissionServiceOptions,
  sessionId: string,
  input: AdmitPromptInput,
): Promise<AdmitPromptResult> {
  const attachments = normalizePromptAttachments(input.attachments);
  const delivery =
    attachments.length > 0 && input.delivery === "steer"
      ? "queue"
      : (input.delivery ?? "queue");
  const traceId =
    normalizeTraceId(input.traceId) ??
    normalizeTraceId(input.metadata?.traceId) ??
    randomUUID();
  const metadata = { ...(input.metadata ?? {}), traceId };
  const runMetadata = { ...(input.runMetadata ?? {}), traceId };
  const existingInput = input.id
    ? options.conversationTransactions.getInput(input.id)
    : undefined;

  if (existingInput) {
    if (
      existingInput.sessionId !== sessionId ||
      !jsonEqual(existingInput.items, inputItems(input)) ||
      existingInput.delivery !== delivery ||
      promptAttachmentFingerprint(
        existingInput.attachments.map((reference) => ({
          assetId: reference.assetId,
          intent: reference.intent,
          ...(typeof reference.metadata?.requestedDisplayName === "string"
            ? { displayName: reference.metadata.requestedDisplayName }
            : {}),
        })),
      ) !== promptAttachmentFingerprint(attachments) ||
      !jsonEqual(
        withoutTraceId(existingInput.metadata),
        withoutTraceId(metadata),
      )
    ) {
      throw new AttachmentError(
        "prompt_id_conflict",
        `Prompt id is already used: ${input.id}`,
      );
    }
    const existingRun = options.runOperations.findRunByInput(existingInput.id);
    if (!existingRun && options.runtimeQueue.hasRuntime) {
      const before = options.events.checkpoint();
      const recovered = options.runOperations.createRun({
        sessionId,
        inputId: existingInput.id,
        metadata: { ...runMetadata, recoveredAdmission: true },
      });
      options.events.publishSince(before);
      return {
        input: existingInput,
        run: recovered,
        queue_state: options.runtimeQueue.enqueueRun(recovered, existingInput.id),
      };
    }
    return {
      input: existingInput,
      ...(existingRun ? { run: existingRun } : {}),
      ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
      ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
    };
  }

  const before = options.events.checkpoint();
  if (delivery === "queue" && options.runtimeQueue.hasRuntime) {
    const admission = {
      prompt: {
        id: input.id,
        sessionId,
        delivery,
        items: inputItems(input),
        content: input.content,
        attachments,
        metadata,
      },
      run: { metadata: runMetadata },
    };
    const admitted = options.attachmentLimits
      ? options.conversationTransactions.admitPromptWithRun(admission, {
          attachmentLimits: options.attachmentLimits,
        })
      : options.conversationTransactions.admitPromptWithRun(admission);
    options.events.publishSince(before);
    return {
      input: admitted.input,
      run: admitted.run,
      queue_state: options.runtimeQueue.enqueueRun(admitted.run, admitted.input.id),
    };
  }

  const admission = {
    id: input.id,
    sessionId,
    delivery,
    items: inputItems(input),
    content: input.content,
    attachments,
    metadata,
  };
  const admitted = options.attachmentLimits
    ? options.conversationTransactions.admitPrompt(admission, {
        attachmentLimits: options.attachmentLimits,
      })
    : options.conversationTransactions.admitPrompt(admission);

  if (delivery === "steer" && options.runtimeQueue.hasRuntime) {
    const items = inputItems(input);
    const steerContent = items.some((item) => item.type === "skill")
      ? await materializeSteerInput(options, sessionId, items)
      : admitted.content;
    const steered = options.runtimeQueue.steer(sessionId, {
      id: admitted.id,
      content: steerContent,
      inputItems: admitted.items,
      delivery: "steer",
      traceId,
      metadata: admitted.metadata,
    });
    if (steered.merged && steered.activeRunId) {
      options.events.publishSince(before);
      let delivered: Awaited<typeof steered.delivery>;
      try {
        delivered = await steered.delivery;
      } catch (error) {
        terminalizeUndeliveredSteer(options, sessionId, admitted.id, traceId, error);
        throw error;
      }
      const activeRun = options.runOperations.getRun(delivered.runId);
      if (!activeRun || activeRun.sessionId !== sessionId) {
        throw new Error(`Steered input run was not found: ${delivered.runId}`);
      }
      return {
        input: admitted,
        run: activeRun,
        ...(activeRun.status === "running" ? { queue_state: "running" as const } : {}),
        ...(activeRun.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
  }

  const run = options.runtimeQueue.hasRuntime
    ? options.runOperations.createRun({
        sessionId,
        inputId: admitted.id,
        metadata: runMetadata,
      })
    : undefined;
  options.events.publishSince(before);
  let queueState: "running" | "queued" | undefined;
  if (run) {
    queueState = options.runtimeQueue.enqueueRun(run, admitted.id);
  }
  return {
    input: admitted,
    ...(run ? { run, queue_state: queueState } : {}),
  };
}

async function materializeSteerInput(
  options: RunAdmissionServiceOptions,
  sessionId: string,
  items: readonly SessionUserInputItem[],
): Promise<string> {
  if (!items.some((item) => item.type === "skill")) return sessionUserInputText(items);
  if (!options.materializer?.materializeSteerInput) {
    throw new Error("session_input_skill_catalog_unavailable");
  }
  return await options.materializer.materializeSteerInput(sessionId, items);
}

function terminalizeUndeliveredSteer(
  options: RunAdmissionServiceOptions,
  sessionId: string,
  inputId: string,
  traceId: string,
  error: unknown,
): void {
  if (options.runOperations.findRunByInput(inputId)) return;
  const message = error instanceof Error ? error.message : String(error);
  const interrupted = error instanceof RunInterruptedError;
  const before = options.events.checkpoint();

  const doTerminalize = () => {
    const created = options.runOperations.createRun({
      sessionId,
      inputId,
      metadata: { traceId, steerDeliveryFailed: true },
    });
    options.runOperations.appendEvent?.({
      type: interrupted ? "session.run.interrupted" : "session.run.error",
      sessionId,
      payload: {
        runId: created.id,
        traceId,
        error: message,
        steerDeliveryFailure: true,
      },
    });
    options.runOperations.updateRun(created.id, {
      status: interrupted ? "interrupted" : "failed",
      error: message,
    });
  };

  if (options.runOperations.transaction) {
    options.runOperations.transaction(doTerminalize);
  } else {
    doTerminalize();
  }
  options.events.publishSince(before);
}
