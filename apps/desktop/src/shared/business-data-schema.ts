import { z } from "zod"
const string = z.string()
const item = z.union([
  z.object({ type: z.literal("text"), text: string }),
  z.object({
    type: z.literal("mention"),
    name: string,
    path: string,
    displayName: string.optional(),
  }),
  z.object({
    type: z.literal("skill"),
    name: string,
    path: string,
    displayName: string.optional(),
    source: z.enum(["bundled", "user", "project", "plugin"]).optional(),
  }),
  z.object({
    type: z.literal("context"),
    kind: z.literal("conversation"),
    id: string,
    displayName: string,
  }),
  z.object({
    type: z.literal("capability"),
    kind: z.literal("plugin"),
    pluginId: string,
    displayName: string,
  }),
  z.object({
    type: z.literal("capability"),
    kind: z.literal("plugin_agent"),
    pluginId: string,
    agentId: string,
    displayName: string,
  }),
])
const document = z.object({ version: z.literal(1), items: z.array(item) })
export const composerAttachmentSchema = z.object({
  draftId: string,
  taskId: string,
  displayName: string,
  declaredMediaType: string,
  sizeBytes: z.number().nonnegative(),
  bytesUploaded: z.number().nonnegative(),
  progress: z.number().nullable(),
  status: z.enum(["uploading", "ready", "failed", "cancelled"]),
  assetId: string.optional(),
  mediaType: string.optional(),
  pastedText: string.optional(),
  error: z.object({ code: string, message: string, retryable: z.boolean() }).optional(),
})
export const composerDraftSchema = z.object({
  document,
  attachments: z.array(composerAttachmentSchema),
  textSelections: z.array(z.object({ id: string, text: string })).optional(),
  browserAnnotations: z
    .array(
      z.object({
        id: string,
        pageUrl: string,
        target: string,
        selector: string,
        locatorKind: z.enum(["unique-id", "semantic", "path"]),
        tagName: string,
        role: string,
        name: string,
        comment: string,
      })
    )
    .optional(),
})
export const composerSubmissionSchema = z.object({
  browserAnnotationContext: string.nullable().optional(),
  id: string.min(1),
  sessionId: string.min(1),
  items: z.array(item),
  attachments: z.array(
    z.object({
      assetId: string.min(1),
      intent: z.enum(["auto", "vision", "ocr", "document", "tool_resource", "workspace_reference"]),
      displayName: string,
      mediaType: string,
      sizeBytes: z.number().nonnegative(),
    })
  ),
  createdAt: z.number(),
  placement: z.enum(["transcript", "queue"]),
  error: string.optional(),
  dismissed: z.boolean().optional(),
  pluginAppContextIds: z.array(string).optional(),
  draftDocument: document.optional(),
  draftAttachmentIds: z.array(string).optional(),
})

export const composerRecoverySchema = z.object({
  version: z.literal(1),
  drafts: z.record(string, composerDraftSchema),
  submissions: z.array(composerSubmissionSchema),
})
export const noteRecoverySchema = z.object({
  version: z.literal(1),
  drafts: z.array(
    z.object({
      draftId: string.trim().min(1),
      noteId: string.trim().min(1).nullable(),
      baseRevision: z.number().int().positive().nullable(),
      content: string,
      updatedAt: z.number().finite(),
    })
  ),
})
export const imageRegionsSchema = z
  .array(
    z.object({
      id: string.min(1),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
      comment: string.max(2000),
    })
  )
  .max(100)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length)
export const businessDataKeySchema = z.union([
  z.object({ kind: z.enum(["composer", "notes", "quick-notes"]) }).strict(),
  z
    .object({ kind: z.literal("image-annotations"), imageKey: string.regex(/^[a-f0-9]{64}$/) })
    .strict(),
])
export const businessSchemas = {
  composer: composerRecoverySchema,
  notes: noteRecoverySchema,
  "quick-notes": noteRecoverySchema,
  "image-annotations": imageRegionsSchema,
}
