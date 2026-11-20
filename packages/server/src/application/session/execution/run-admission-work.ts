import { randomUUID } from "node:crypto";
import { assertSupportedOutputSchema } from "@vykor/agent-runtime";
import { SessionApplicationError } from "../session-application-error.js";
import { readSessionObservationGrant } from "./session-observation-grant.js";
import { normalizeSessionUserInputItems, sessionUserInputText } from "@vykor/domain-contracts/inputs";
import type { SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import { AttachmentError, normalizePromptAttachments, promptAttachmentFingerprint } from "@vykor/services";
import { jsonEqual, normalizeTraceId, withoutTraceId } from "../../support.js";
import { RunInterruptedError } from "../../../runtime/run-coordinator.js";
import type { AdmitPromptInput, AdmitPromptResult, RunAdmissionServiceOptions } from "./run-admission-service.js";

/** Validate a new request; metadata snapshots are never request aliases. */
export function validateOutputSchemaRequest<T extends {
  outputSchema?: Record<string, unknown>;
  delivery?: "queue" | "steer";
}>(input: T): T & { outputSchema?: Record<string, unknown> } {
  if (input.outputSchema === undefined) return input;
  if (input.delivery === "steer") throw new SessionApplicationError(400, "outputSchema requires a queued Run; steer cannot change its contract");
  return { ...input, outputSchema: validateSchema(input.outputSchema) };
}

function validateSchema(value: unknown): Record<string, unknown> {
  try {
    assertSupportedOutputSchema(value as Record<string, unknown>);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > 65_536) throw new Error("Output schema exceeds 64 KiB");
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) {
    throw new SessionApplicationError(400, `Invalid output schema: ${error instanceof Error ? error.message : "unsupported constraint"}`);
  }
}

/** Read legacy Input/Run snapshots without treating them as new request parameters. */
export function readStoredOutputSchema(inputMetadata: Record<string, unknown>, runMetadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  const input = inputMetadata.outputSchema, run = runMetadata?.outputSchema;
  if (input !== undefined && run !== undefined && !jsonEqual(input, run)) {
    throw new SessionApplicationError(400, "Conflicting stored output schemas");
  }
  const schema = input !== undefined ? input : run;
  return schema === undefined ? undefined : validateSchema(schema);
}

/** Persist the validated explicit contract in the existing record shape. */
export function outputSchemaMetadata(metadata: Record<string, unknown> | undefined, outputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...metadata, ...(outputSchema === undefined ? {} : { outputSchema }) };
}

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
  prioritizeObservation: () => void,
): Promise<AdmitPromptResult | { completion: Promise<AdmitPromptResult> }> {
  const targetRunId = input.expectedActiveRunId;
  if (targetRunId !== undefined && (input.attachments?.length || input.pluginAppContexts?.length)) {
    throw new SessionApplicationError(409, "Attachments and app context require a queued Run");
  }
  if (input.pluginAppContexts?.length) {
    if (!options.materializePluginAppContexts || input.delivery === "steer") throw new Error("plugin_app_context_unavailable");
    const contexts = await options.materializePluginAppContexts(sessionId, input.pluginAppContexts);
    const { pluginAppContexts: _credentials, ...ordinaryInput } = input;
    input = { ...ordinaryInput, items: normalizeSessionUserInputItems([
      ...inputItems(input), { type: "text", text: "\n\n" }, ...contexts.items,
    ]) };
    contexts.assertCurrent();
  }
  const attachments = normalizePromptAttachments(input.attachments);
  const delivery =
    attachments.length > 0 && input.delivery === "steer"
      ? "queue"
      : (input.delivery ?? "queue");
  const traceId =
    normalizeTraceId(input.traceId) ??
    normalizeTraceId(input.metadata?.traceId) ??
    randomUUID();
  const metadata = {
    ...outputSchemaMetadata(input.metadata, input.outputSchema),
    ...(targetRunId !== undefined ? { steerTargetRunId: targetRunId } : {}),
    traceId,
  };
  const runMetadata: Record<string, unknown> = { ...outputSchemaMetadata(input.runMetadata, input.outputSchema), traceId };
  const existingInput = input.id
    ? options.conversationTransactions.getInput(input.id)
    : undefined;

  if (existingInput) {
    const existingRun = options.runOperations.findRunByInput(existingInput.id);
    const observationTarget = existingRun?.inputId === existingInput.id
      ? readSessionObservationGrant(existingRun)?.targetSessionId
      : undefined;
    if (
      existingInput.sessionId !== sessionId ||
      observationTarget !== input.observationTargetSessionId ||
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
    if (targetRunId !== undefined) {
      const target = existingRun ?? options.runOperations.getRun(targetRunId);
      return { input: existingInput, ...(target?.sessionId === sessionId ? { run: target } : {}) };
    }
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

  let before = options.events.checkpoint();
  if (input.observationTargetSessionId !== undefined) {
    if (!options.runtimeQueue.hasRuntime || !options.createObservationGrant) {
      throw new SessionApplicationError(409, "observe-session requires an available session runtime");
    }
    runMetadata.sessionObservationGrant = options.createObservationGrant(sessionId, input.observationTargetSessionId, before);
    prioritizeObservation();
    before = options.events.checkpoint();
  }
  if (delivery === "queue" && options.runtimeQueue.hasRuntime) {
    if (input.delivery !== "steer" && input.allowSessionLookup === true) runMetadata.sessionLookupAllowed = true;
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

  const items = inputItems(input);
  const steerContent = delivery === "steer" && options.runtimeQueue.hasRuntime && items.some(item => item.type === "skill")
    ? await materializeSteerInput(options, sessionId, items)
    : undefined;
  if (targetRunId !== undefined &&
      (!options.runtimeQueue.hasRuntime || options.runtimeQueue.activeRunId?.(sessionId) !== targetRunId ||
        options.runOperations.getRun(targetRunId)?.status !== "running")) {
    throw new SessionApplicationError(409, "active_run_changed");
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
    const steered = options.runtimeQueue.steer(sessionId, {
      id: admitted.id,
      content: steerContent ?? admitted.content,
      inputItems: admitted.items,
      delivery: "steer",
      traceId,
      metadata: admitted.metadata,
    }, targetRunId === undefined ? undefined : { expectedActiveRunId: targetRunId });
    if (steered.merged && steered.activeRunId) {
      options.events.publishSince(before);
      if (targetRunId !== undefined) prioritizeObservation();
      const completion = steered.delivery.then(delivered => {
        const activeRun = options.runOperations.getRun(delivered.runId);
        if (!activeRun || activeRun.sessionId !== sessionId || (targetRunId !== undefined && activeRun.id !== targetRunId)) {
          throw new Error(`Steered input run was not found: ${delivered.runId}`);
        }
        return {
          input: admitted,
          run: activeRun,
          ...(activeRun.status === "running" ? { queue_state: "running" as const } : {}),
          ...(activeRun.status === "pending" ? { queue_state: "queued" as const } : {}),
        };
      }, error => {
        terminalizeUndeliveredSteer(options, sessionId, admitted.id, traceId, error);
        if (targetRunId !== undefined) throw new SessionApplicationError(409, "steer_delivery_failed");
        throw error;
      });
      void completion.catch(() => {});
      return { completion };
    }
  }

  if (targetRunId !== undefined) {
    options.events.publishSince(before);
    const error = new SessionApplicationError(409, "active_run_changed");
    terminalizeUndeliveredSteer(options, sessionId, admitted.id, traceId, error);
    throw error;
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
