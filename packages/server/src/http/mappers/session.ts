import type * as Wire from "@vykor/protocol";
import type * as App from "../../application/session/inputs.js";

/** Network fields are selected explicitly before entering the application. */
export function sessionCreateInput(input: Wire.CreateSessionInput): App.CreateSessionInput {
  return { cwd: input.cwd, model: input.model,
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.storage !== undefined ? { storage: input.storage } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) };
}
export function sessionForkInput(input: Wire.ForkSessionInput): App.ForkSessionInput {
  return { ...(input.copyHistory !== undefined ? { copyHistory: input.copyHistory } : {}),
    ...(input.beforeMessageId !== undefined ? { beforeMessageId: input.beforeMessageId } : {}),
    ...(input.afterMessageId !== undefined ? { afterMessageId: input.afterMessageId } : {}),
    ...(input.storage !== undefined ? { storage: input.storage } : {}) };
}
export function sessionUpdateInput(input: Wire.UpdateSessionInput): App.UpdateSessionInput {
  return { ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) };
}
export function sessionClearWorktreeInput(input: Wire.ClearSessionWorktreeBindingInput): App.ClearSessionWorktreeBindingInput {
  return { id: input.id, path: input.path, branch: input.branch };
}
