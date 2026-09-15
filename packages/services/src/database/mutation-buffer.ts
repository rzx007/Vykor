export interface MutationBuffer {
  sessions: Set<string>;
  inputs: Set<string>;
  inputAttachments: Set<string>;
  messages: Set<string>;
  parts: Set<string>;
  runs: Set<string>;
  attempts: Set<string>;
  tasks: Set<string>;
  permissions: Set<string>;
  events: Set<string>;
  deletedMessages: Set<string>;
  deletedParts: Set<string>;
  deletedInputAttachments: Set<string>;
  deletedInputs: Set<string>;
  deletedRuns: Set<string>;
  deletedAttempts: Set<string>;
}

export function createMutationBuffer(): MutationBuffer {
  return {
    sessions: new Set(),
    inputs: new Set(),
    inputAttachments: new Set(),
    messages: new Set(),
    parts: new Set(),
    runs: new Set(),
    attempts: new Set(),
    tasks: new Set(),
    permissions: new Set(),
    events: new Set(),
    deletedMessages: new Set(),
    deletedParts: new Set(),
    deletedInputAttachments: new Set(),
    deletedInputs: new Set(),
    deletedRuns: new Set(),
    deletedAttempts: new Set(),
  };
}

export function cloneMutationBuffer(value: MutationBuffer): MutationBuffer {
  return {
    sessions: new Set(value.sessions),
    inputs: new Set(value.inputs),
    inputAttachments: new Set(value.inputAttachments),
    messages: new Set(value.messages),
    parts: new Set(value.parts),
    runs: new Set(value.runs),
    attempts: new Set(value.attempts),
    tasks: new Set(value.tasks),
    permissions: new Set(value.permissions),
    events: new Set(value.events),
    deletedMessages: new Set(value.deletedMessages),
    deletedParts: new Set(value.deletedParts),
    deletedInputAttachments: new Set(value.deletedInputAttachments),
    deletedInputs: new Set(value.deletedInputs),
    deletedRuns: new Set(value.deletedRuns),
    deletedAttempts: new Set(value.deletedAttempts),
  };
}
