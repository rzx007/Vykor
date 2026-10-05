export type AnnotationMode = "off" | "pick" | "review"
export type AnnotationRect = { x: number; y: number; width: number; height: number }
export type AnnotationTarget = {
  target: string
  selector: string
  locatorKind: "unique-id" | "semantic" | "path"
  tagName: string
  role: string
  name: string
}
export type BrowserAnnotationRecord = AnnotationTarget & {
  id: string
  pageUrl: string
  comment: string
}
export type LocatedAnnotation = {
  record: BrowserAnnotationRecord
  status: "visible" | "offscreen" | "missing"
  rect: AnnotationRect | null
}
export type BrowserAnnotationSnapshot = {
  pageUrl: string
  pageRevision: number
  ready: boolean
  mode: AnnotationMode
  interactionVersion: number
  eventSequence: number
  selection: { selectionId: string; target: AnnotationTarget; rect: AnnotationRect } | null
  focusedAnnotationId: string | null
  viewport: { width: number; height: number } | null
  annotations: LocatedAnnotation[]
}
export type AnnotationPageInput = { tabId: string; pageRevision: number }
export type AddAnnotationInput = AnnotationPageInput & { selectionId: string; comment: string }
export type AnnotationIdInput = AnnotationPageInput & { annotationId: string }
export type SetAnnotationModeInput = AnnotationPageInput & { mode: AnnotationMode }
export type PageMarker = AnnotationTarget & { id: string; handleId: string | null }
export type PageAnnotationSnapshot = {
  mode: AnnotationMode
  interactionVersion: number
  eventSequence: number
  selected: (AnnotationTarget & { handleId: string; rect: AnnotationRect }) | null
  focusedAnnotationId: string | null
  viewport: { width: number; height: number }
  markers: Array<{ id: string; status: LocatedAnnotation["status"]; rect: AnnotationRect | null }>
}
export type PageAnnotationCommand = { interactionVersion: number } & (
  | { action: "install"; mode: "pick" | "review" }
  | { action: "read" }
  | { action: "syncMarkers"; markers: PageMarker[] }
  | { action: "validateSelection"; handleId: string }
  | { action: "focusAnnotation"; annotationId: string }
  | { action: "stop" }
)
