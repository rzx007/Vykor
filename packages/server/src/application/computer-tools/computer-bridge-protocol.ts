export const COMPUTER_HOST_TOKEN_HEADER = "x-vykor-computer-token";
export const COMPUTER_SESSION_UNAVAILABLE = "computer_session_unavailable";
export const COMPUTER_CAPTURE_MAX_BASE64_BYTES = 1024 * 1024;
const maxCaptureSide = 2000;

export interface ComputerRunIdentity {
  sessionId: string;
  runId: string;
  inputId: string;
}

export type ComputerSemanticAction =
  | { type: "invoke"; elementRef: string }
  | { type: "choose"; elementRef: string }
  | { type: "set_text"; elementRef: string; text: string }
  | { type: "scroll"; elementRef: string; direction: "up" | "down" | "left" | "right"; amount?: number };

export interface ComputerApprovalProposal {
  proposalId: string;
  reason: string;
}

export type ComputerPointerGesture = { x: number; y: number } & (
  | { type: "click"; button?: "left" | "right"; count?: 1 | 2; modifiers?: Array<"ctrl" | "shift"> }
  | { type: "drag"; toX: number; toY: number }
  | { type: "scroll_at"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { type: "hover" }
);

export type ComputerCaptureRegion = { x: number; y: number; width: number; height: number };
export type ComputerCaptureAction = { type: "capture" } & (
  | { purpose?: "result" }
  | { frameRef: string; region: ComputerCaptureRegion }
);

export type ComputerForegroundAction =
  | (ComputerPointerGesture & { frameRef: string })
  | { type: "key"; key: string; modifiers?: Array<"ctrl" | "shift" | "alt"> }
  | { type: "type_text"; text: string };

export type ComputerAction =
  | { type: "observe" }
  | ComputerCaptureAction
  | { type: "foreground" }
  | { type: "handoff" }
  | { type: "open_app"; app: string; windowHint?: string; newWindow?: true }
  | ComputerSemanticAction
  | ComputerForegroundAction;

export interface ComputerCaptureImage {
  mediaType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
}

export type ComputerResult = { text: string; status?: "observed" | "sent" | "unchanged"; image?: ComputerCaptureImage };
export type ComputerExecutionState = "not_started" | "unknown";
export type ComputerReply = { result: ComputerResult } | { error: string; executionState: ComputerExecutionState };

export type ComputerBridgeEvent =
  | { type: "connected"; connectionId: string }
  | { type: "cancel"; requestId: string }
  | { type: "ended"; run: ComputerRunIdentity }
  | {
      type: "execute";
      requestId: string;
      run: ComputerRunIdentity;
      action: ComputerAction;
      deadlineAt: number;
      /** The daemon will authorize direct dispatch while this request's scope remains current. */
      fullAccess?: true;
    };

export function computerActionNeedsApproval(action: ComputerAction): boolean {
  switch (action.type) {
    case "foreground": case "click": case "drag": case "scroll_at": case "hover": case "type_text":
    case "invoke": case "choose": case "set_text":
      return true;
    case "key":
      return Boolean(action.modifiers?.length) || !/^(?:Tab|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/iu.test(action.key);
    default:
      return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 && !/\p{Cc}/u.test(value)
    ? value.trim() || undefined : undefined;
}

function validActionText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < maxCaptureSide;
}

function scrollDirection(value: unknown): value is "up" | "down" | "left" | "right" {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

function scrollAmount(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5);
}

function frameReference(value: unknown): value is string {
  return typeof value === "string" && /^frame_[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(value);
}

function modifierList<T extends string>(value: unknown, allowed: readonly T[]): value is T[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= allowed.length &&
    new Set(value).size === value.length && value.every(item => allowed.includes(item)));
}

function parsePointerAction(value: Record<string, unknown>): ComputerForegroundAction | undefined {
  const { type, frameRef, x, y, button, count, toX, toY, modifiers, direction, amount } = value;
  if (!frameReference(frameRef) || !coordinate(x) || !coordinate(y)) return;
  const extraKeys = Object.keys(value).filter(key => key !== "type" && key !== "frameRef" && key !== "x" && key !== "y");
  const point = { frameRef, x, y };
  if (type === "click" && extraKeys.every(key => key === "button" || key === "count" || key === "modifiers") &&
    (button === undefined || button === "left" || button === "right") &&
    (count === undefined || count === 1 || (count === 2 && button !== "right")) &&
    modifierList(modifiers, ["ctrl", "shift"] as const)) {
    return { type, ...point, ...(button ? { button } : {}), ...(count ? { count } : {}), ...(modifiers ? { modifiers } : {}) };
  }
  if (type === "drag" && extraKeys.length === 2 && coordinate(toX) && coordinate(toY) && (x !== toX || y !== toY)) {
    return { type, ...point, toX, toY };
  }
  if (type === "scroll_at" && extraKeys.every(key => key === "direction" || key === "amount") && scrollDirection(direction) && scrollAmount(amount)) {
    return { type, ...point, direction, ...(amount === undefined ? {} : { amount }) };
  }
  if (type === "hover" && extraKeys.length === 0) return { type, ...point };
}

function captureRegion(value: unknown): ComputerCaptureRegion | undefined {
  if (!record(value) || Object.keys(value).length !== 4) return;
  const { x, y, width, height } = value;
  if (!coordinate(x) || !coordinate(y) || typeof width !== "number" || typeof height !== "number" ||
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    x + width > maxCaptureSide || y + height > maxCaptureSide) return;
  return { x, y, width, height };
}

function parseRun(value: unknown): ComputerRunIdentity | undefined {
  if (record(value) && id(value.sessionId) && id(value.runId) && id(value.inputId)) {
    return { sessionId: value.sessionId, runId: value.runId, inputId: value.inputId };
  }
}

export function parseComputerAction(value: unknown): ComputerAction | undefined {
  if (!record(value)) return;
  const { type, elementRef, text, direction, amount, key, modifiers } = value;
  const keys = Object.keys(value);
  if ((type === "observe" || type === "foreground" || type === "handoff") && keys.length === 1) return { type };
  if (type === "capture") {
    if (keys.length === 1) return { type };
    if (value.purpose === "result" && keys.length === 2) return { type, purpose: "result" };
    if (keys.length === 3 && frameReference(value.frameRef)) {
      const region = captureRegion(value.region);
      if (region) return { type, frameRef: value.frameRef, region };
    }
    return;
  }
  if (type === "click" || type === "drag" || type === "scroll_at" || type === "hover") return parsePointerAction(value);
  if (type === "key" && keys.every(name => name === "type" || name === "key" || name === "modifiers")
    && typeof key === "string" && /^[a-z\d][a-z\d_-]{0,23}$/iu.test(key)
    && modifierList(modifiers, ["ctrl", "shift", "alt"] as const)) {
    return { type, key, ...(modifiers ? { modifiers } : {}) };
  }
  if (type === "type_text" && keys.length === 2 && typeof text === "string" && text.length > 0
    && text.length <= 1000 && !/\p{Cc}/u.test(text)) return { type, text };
  if (value.type === "open_app") {
    if (Object.keys(value).some(key => !["type", "app", "windowHint", "newWindow"].includes(key))) return;
    const app = label(value.app);
    const windowHint = label(value.windowHint);
    if (app && (value.windowHint === undefined || windowHint) &&
      (value.newWindow === undefined || value.newWindow === true && value.windowHint === undefined)) {
      return { type: "open_app", app, ...(windowHint ? { windowHint } : {}), ...(value.newWindow ? { newWindow: true } : {}) };
    }
    return;
  }
  if (!id(elementRef) || !/^element_[a-f\d-]{36}$/u.test(elementRef)) return;
  if ((type === "invoke" || type === "choose") && Object.keys(value).length === 2) return { type, elementRef };
  if (type === "set_text" && keys.length === 3 && validActionText(text)) return { type, elementRef, text };
  if (type === "scroll" && Object.keys(value).every(key => ["type", "elementRef", "direction", "amount"].includes(key))
    && scrollDirection(direction) && scrollAmount(amount)) {
    return { type, elementRef, direction, ...(typeof amount === "number" ? { amount } : {}) };
  }
}

export function parseComputerBridgeEvent(value: unknown): ComputerBridgeEvent {
  if (record(value)) {
    const { type, connectionId, requestId, deadlineAt } = value;
    if (type === "connected" && id(connectionId)) return { type, connectionId };
    if (type === "cancel" && id(requestId)) return { type, requestId };
    const run = parseRun(value.run);
    if (type === "ended" && run) return { type, run };
    const action = parseComputerAction(value.action);
    if (type === "execute" && id(requestId) && run && action
      && typeof deadlineAt === "number" && Number.isFinite(deadlineAt)) {
      return { type, requestId, run, action, deadlineAt, ...(value.fullAccess === true ? { fullAccess: true } : {}) };
    }
  }
  throw new Error("Invalid Computer bridge event.");
}

function captureDimensions(bytes: Buffer, mediaType: ComputerCaptureImage["mediaType"]): [number, number] | undefined {
  if (mediaType === "image/png") {
    if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
      || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") return;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length < 8 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  for (let cursor = 2; cursor + 3 < bytes.length;) {
    if (bytes[cursor++] !== 0xff) return;
    while (bytes[cursor] === 0xff) cursor++;
    if (cursor + 2 >= bytes.length) return;
    const marker = bytes[cursor++]!;
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length || marker === 0xda) return;
    // Windows uses baseline JPEG. Progressive JPEG is also a valid model image.
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return [bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3)];
    }
    cursor += length;
  }
}

function parseCaptureImage(value: unknown): ComputerCaptureImage | undefined {
  if (!record(value) || Object.keys(value).length !== 4) return;
  const { mediaType, data, width, height } = value;
  if ((mediaType !== "image/png" && mediaType !== "image/jpeg")
    || typeof width !== "number" || !coordinate(width - 1) || typeof height !== "number" || !coordinate(height - 1)
    || typeof data !== "string" || data.length > COMPUTER_CAPTURE_MAX_BASE64_BYTES || data.length % 4 !== 0
    || !/^[a-z\d+/]+={0,2}$/iu.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return;
  const dimensions = captureDimensions(bytes, mediaType);
  if (!dimensions || dimensions[0] !== width || dimensions[1] !== height) return;
  return { mediaType, data, width, height };
}

export function parseComputerReply(body: Record<string, unknown>): ComputerReply | undefined {
  const { result, error, executionState } = body;
  if (record(result) && typeof result.text === "string" && Object.keys(body).length === 1
    && Object.keys(result).every(key => key === "text" || key === "image" || key === "status")) {
    const { status } = result;
    if (status !== undefined && status !== "observed" && status !== "sent" && status !== "unchanged") return;
    const image = parseCaptureImage(result.image);
    if (result.image !== undefined && !image) return;
    return { result: { text: result.text, ...(status ? { status } : {}), ...(image ? { image } : {}) } };
  }
  if (typeof error === "string" && error.length > 0 && error.length <= 4_096
    && (executionState === "not_started" || executionState === "unknown") && Object.keys(body).length === 2) {
    return { error, executionState };
  }
}
