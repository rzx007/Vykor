import { setTimeout as delay } from "node:timers/promises"
import { HttpTransport, SseTransport, VykorApiError, type AdmitClientPromptInput, type PromptResponse } from "@rzx/client"
import {
  COMPUTER_HOST_TOKEN_HEADER,
  COMPUTER_SESSION_UNAVAILABLE,
  parseComputerBridgeEvent,
  type ComputerApprovalProposal,
  type ComputerBridgeEvent,
  type ComputerReply,
  type ComputerResult,
} from "@vykor/server/daemon-host"
import { isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"
import { nativeDaemonFetch } from "../daemon-autostart/native-daemon-fetch"

type ExecuteEvent = Extract<ComputerBridgeEvent, { type: "execute" }>
export type ComputerHostResponse = ComputerResult | Extract<ComputerReply, { error: string }>
export type DesktopComputerApproval = (proposal: ComputerApprovalProposal, signal?: AbortSignal) => Promise<boolean>
export type DesktopComputerDispatch = (signal?: AbortSignal) => Promise<boolean>
export type DesktopComputerDriver = (
  request: ExecuteEvent, signal: AbortSignal, connection: AbortSignal, approve: DesktopComputerApproval, dispatch: DesktopComputerDispatch,
) => Promise<ComputerHostResponse>

interface ComputerBridgeOptions {
  baseUrl: string
  daemonPid: number
  daemonToken: string
  computerToken: string
  authorizeDaemon: () => void
  onDaemonIdentityMismatch?: () => void
  execute?: DesktopComputerDriver
  revoke?: (sessionId: string, runId?: string) => void
  cancel?: (sessionId: string, runId: string) => void
}

interface Submission {
  sessionId: string
  runId?: string
  stopped: boolean
  stoppedRunIds?: Set<string>
  dispatchedRequests: Set<string>
}

interface Connection {
  id: string
  signal: AbortSignal
  disconnect(): void
  submissions: Map<string, Submission>
  activeRun?: ExecuteEvent["run"]
  capture?: { requestId: string; run: ExecuteEvent["run"] }
  captureRevocation?: { run: ExecuteEvent["run"]; confirmed: Promise<boolean> }
}

interface Execution {
  connection: Connection
  event: ExecuteEvent
  abort: AbortController
  signal: AbortSignal
  awaitingApproval: boolean
}

const streamPath = "/computer-host/stream"

function bindRun(submission: Submission, runId: string): void {
  if (submission.runId !== undefined) return
  submission.runId = runId
  submission.stopped ||= submission.stoppedRunIds?.has(runId) === true
  submission.stoppedRunIds = undefined
}

/** The private path definitively did not admit the prompt. */
export class ComputerPromptNotSubmittedError extends Error {}

export class DesktopComputerBridge {
  private readonly http: HttpTransport
  private readonly headers: Record<string, string>
  private readonly shutdown = new AbortController()
  private connection?: Connection
  private executing?: Execution

  constructor(private readonly options: ComputerBridgeOptions) {
    if (!isLoopbackDaemonUrl(options.baseUrl) || new URL(options.baseUrl).protocol !== "http:")
      throw new Error("电脑操作需要本机后台。")
    this.http = new HttpTransport({
      baseUrl: options.baseUrl,
      token: options.daemonToken,
      fetch: (url, request) => {
        options.authorizeDaemon()
        return nativeDaemonFetch(url, request)
      },
    })
    this.headers = { [COMPUTER_HOST_TOKEN_HEADER]: options.computerToken }
    void this.run()
  }

  async submit(
    sessionId: string, input: AdmitClientPromptInput, authorize: () => void, signal?: AbortSignal,
    admissionSignal = signal,
  ): Promise<PromptResponse> {
    // A caller waits for a handshake, never replays an already-sent submit.
    try {
      const waiting = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
      while (!this.connection) {
        await delay(50, undefined, { signal: waiting }).catch(() => {
          signal?.throwIfAborted()
          throw new Error("电脑操作桥暂时无法连接，请重试。")
        })
      }
      signal?.throwIfAborted()
      authorize()
      this.options.authorizeDaemon()
    } catch (error) {
      throw new ComputerPromptNotSubmittedError(error instanceof Error ? error.message : String(error), { cause: error })
    }
    const connection = this.connection
    const inputId = input.id
    if (!inputId) throw new Error("电脑操作需要消息 ID。")
    const remembered = connection.submissions.get(inputId)
    const submission: Submission = remembered ?? { sessionId, stopped: false, dispatchedRequests: new Set() }
    connection.submissions.set(inputId, submission)
    try {
      const response = await this.http.request<PromptResponse>(this.path(connection, "submit"), {
        method: "POST",
        body: { sessionId, input },
        headers: this.headers,
        signal: admissionSignal ? AbortSignal.any([connection.signal, admissionSignal]) : connection.signal,
      })
      if (response.run) {
        bindRun(submission, response.run.id)
        if (response.run.status !== "running" && response.run.status !== "pending" &&
          connection.submissions.get(inputId) === submission) connection.submissions.delete(inputId)
      }
      return response
    } catch (error) {
      if (!remembered && !submission.runId && connection.submissions.get(inputId) === submission &&
        error instanceof VykorApiError && error.status >= 400 && error.status < 500) {
        connection.submissions.delete(inputId)
        const body = error.body
        if (error.status === 409 && body && typeof body === "object" &&
          "code" in body && body.code === COMPUTER_SESSION_UNAVAILABLE)
          throw new ComputerPromptNotSubmittedError(error.message, { cause: error })
      }
      throw error
    }
  }

  revoke(sessionId: string, runId?: string): void {
    const connection = this.connection
    if (connection) {
      const capture = connection.capture
      if (capture?.run.sessionId === sessionId && (!runId || capture.run.runId === runId)) {
        void this.invalidateCapturedImage(sessionId, capture.run.runId)
      }
      if (connection.activeRun?.sessionId === sessionId && (!runId || connection.activeRun.runId === runId)) {
        connection.activeRun = undefined
      }
      for (const submission of connection.submissions.values()) {
        if (submission.sessionId !== sessionId) continue
        if (!runId || submission.runId === runId) submission.stopped = true
        else if (!submission.runId && !submission.stopped) (submission.stoppedRunIds ??= new Set()).add(runId)
      }
    }
    this.options.revoke?.(sessionId, runId)
    const active = this.executing
    if (!active || active.connection !== connection || active.signal.aborted ||
      active.event.run.sessionId !== sessionId || (runId && active.event.run.runId !== runId)) return
    active.abort.abort()
    void this.result(active.event, active.connection, {
      error: "电脑操作已停止。", executionState: "unknown",
    }, active.connection.signal).catch(() => {})
  }

  invalidateView(nextSessionId?: string): void {
    const sessions = new Set<string>()
    for (const submission of this.connection?.submissions.values() ?? []) {
      if (!submission.stopped && submission.sessionId !== nextSessionId) sessions.add(submission.sessionId)
    }
    for (const sessionId of sessions) this.revoke(sessionId)
  }

  invalidateCapturedImage(sessionId: string, runId: string): Promise<boolean> | undefined {
    const connection = this.connection
    const capture = connection?.capture
    if (!connection) return
    if (capture?.run.sessionId !== sessionId || capture.run.runId !== runId) {
      const revocation = connection.captureRevocation
      return revocation?.run.sessionId === sessionId && revocation.run.runId === runId ? revocation.confirmed : undefined
    }
    connection.capture = undefined
    const tail = `${encodeURIComponent(capture.requestId)}/revoke-image`
    const confirmed = this.http.request(this.path(connection, tail), {
      method: "POST", body: {}, headers: this.headers,
      signal: AbortSignal.any([connection.signal, AbortSignal.timeout(2_000)]),
    }).then(() => true, (error: unknown) => {
      if (error instanceof VykorApiError && error.status === 404) return true
      // Losing revocation acknowledgement also loses the connection's right to send the screenshot.
      connection.disconnect()
      return false
    })
    connection.captureRevocation = { run: capture.run, confirmed }
    return confirmed
  }

  async replyApproval(sessionId: string, requestId: string, status: "approved" | "denied"): Promise<void> {
    const active = this.executing
    if (!active || active.connection !== this.connection || active.signal.aborted ||
      !active.awaitingApproval || active.event.run.sessionId !== sessionId) {
      throw new Error("这次电脑操作的审批已失效。")
    }
    await this.http.request(this.path(active.connection, "approval-reply"), {
      method: "POST", body: { requestId, sessionId, status }, headers: this.headers, signal: active.signal,
    })
  }

  close(): void {
    this.shutdown.abort()
  }

  private path(connection: Connection, trail: string): string {
    return `/computer-host/${encodeURIComponent(connection.id)}/${trail}`
  }

  private async connect(): Promise<void> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal])
    try {
      const process = await this.http.request<{ pid: number }>("/debug/process", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      })
      if (process.pid !== this.options.daemonPid) {
        this.close()
        this.options.onDaemonIdentityMismatch?.()
        return
      }
      const sse = new SseTransport(this.http)
      for await (const event of sse.stream(this.http.resolveUrl(streamPath), {
        headers: this.headers,
        decode: parseComputerBridgeEvent,
        signal,
        idleTimeoutMs: 45_000,
      })) {
        signal.throwIfAborted()
        if (event.type === "connected" && !this.connection) {
          this.connection = {
            id: event.connectionId, signal, disconnect: () => controller.abort(),
            submissions: new Map(),
          }
          continue
        }
        const connection = this.connection
        if (!connection || event.type === "connected") throw new Error("Invalid private computer stream")
        if (event.type === "cancel") {
          const active = this.executing
          if (active?.event.requestId === event.requestId && active.connection === connection) {
            this.options.cancel?.(active.event.run.sessionId, active.event.run.runId)
            active.abort.abort()
          }
        } else if (event.type === "ended") {
          const submission = connection.submissions.get(event.run.inputId)
          if (submission?.sessionId === event.run.sessionId && (!submission.runId || submission.runId === event.run.runId)) {
            connection.submissions.delete(event.run.inputId)
            if (connection.capture?.run.runId === event.run.runId) connection.capture = undefined
            if (connection.captureRevocation?.run.runId === event.run.runId) connection.captureRevocation = undefined
            this.revoke(event.run.sessionId, event.run.runId)
          }
        } else {
          void this.execute(event, connection).catch(() => {
            // A lost reply may follow dispatch to the host. Invalidate the generation.
            if (!signal.aborted) controller.abort()
          })
        }
      }
    } finally {
      this.connection = undefined
      controller.abort()
    }
  }

  private async execute(event: ExecuteEvent, connection: Connection): Promise<void> {
    const remaining = event.deadlineAt - Date.now()
    if (remaining <= 0 || connection.signal.aborted) return
    this.options.authorizeDaemon()
    const submission = connection.submissions.get(event.run.inputId)
    if (submission?.dispatchedRequests.has(event.requestId)) return
    if (submission?.sessionId === event.run.sessionId) bindRun(submission, event.run.runId)
    if (!submission || submission.sessionId !== event.run.sessionId || submission.stopped || submission.runId !== event.run.runId) {
      await this.result(event, connection, { error: "这次运行的电脑操作许可已失效。", executionState: "not_started" }, connection.signal)
      return
    }
    const current = connection.activeRun
    if (current && (current.sessionId !== event.run.sessionId || current.runId !== event.run.runId || current.inputId !== event.run.inputId)) {
      await this.result(event, connection, { error: "另一个运行仍拥有电脑操作许可。", executionState: "not_started" }, connection.signal)
      return
    }
    if (this.executing || !this.options.execute) {
      await this.result(event, connection, {
        error: this.executing ? "另一个电脑操作尚未结束。" : "当前 Desktop 尚未开放 Windows 操作。",
        executionState: "not_started",
      }, connection.signal)
      return
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([
      connection.signal,
      abort.signal,
      AbortSignal.timeout(Math.min(remaining, 2_147_483_647)),
    ])
    const execution: Execution = { connection, event, abort, signal, awaitingApproval: false }
    connection.activeRun = event.run
    submission.dispatchedRequests.add(event.requestId)
    this.executing = execution
    if (event.action.type === "capture") {
      const existing = connection.capture
      if (existing) void this.invalidateCapturedImage(existing.run.sessionId, existing.run.runId)
      connection.capture = { requestId: event.requestId, run: event.run }
    }
    let approvalRequested = false
    const isCurrent = (operation: AbortSignal) => !operation.aborted && this.executing === execution && this.connection === connection
    const approve: DesktopComputerApproval = async (proposal, operation) => {
      const requestSignal = operation ? AbortSignal.any([signal, operation]) : signal
      if (approvalRequested || !isCurrent(requestSignal)) return false
      approvalRequested = true
      execution.awaitingApproval = true
      try {
        const reply = await this.http.request<{ approved: boolean; proposalId: string }>(
          this.path(connection, `${encodeURIComponent(event.requestId)}/approval`), {
            method: "POST", body: proposal, headers: this.headers, signal: requestSignal,
          }
        )
        return isCurrent(requestSignal) && reply.approved === true && reply.proposalId === proposal.proposalId
      } catch (error) {
        if (requestSignal.aborted || error instanceof VykorApiError && (error.status === 404 || error.status === 409)) return false
        throw error
      } finally {
        execution.awaitingApproval = false
      }
    }
    let dispatchRequested = false
    const dispatch: DesktopComputerDispatch = async operation => {
      const requestSignal = operation ? AbortSignal.any([signal, operation]) : signal
      if (dispatchRequested || !isCurrent(requestSignal)) return false
      dispatchRequested = true
      try {
        const reply = await this.http.request<{ authorized: boolean }>(this.path(connection, `${encodeURIComponent(event.requestId)}/dispatch`), {
          method: "POST", body: {}, headers: this.headers, signal: requestSignal,
        })
        return isCurrent(requestSignal) && reply.authorized === true
      } catch (error) {
        if (requestSignal.aborted || error instanceof VykorApiError && (error.status === 404 || error.status === 409)) return false
        throw error
      }
    }
    try {
      const body = await this.options.execute(event, signal, connection.signal, approve, dispatch).then(
        result => {
          if ("error" in result) return result
          return { result: result.image && connection.capture?.requestId !== event.requestId ? { text: result.text } : result }
        },
        () => ({ error: "Desktop 无法确认这次电脑操作的结果。", executionState: "unknown" as const }),
      )
      if (!signal.aborted) await this.result(event, connection, body, signal)
    } finally {
      this.executing = undefined
    }
  }

  private async result(
    event: ExecuteEvent,
    connection: Connection,
    body: ComputerReply,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || this.connection !== connection) return
    try {
      await this.http.request(this.path(connection, `${encodeURIComponent(event.requestId)}/result`), {
        method: "POST",
        body,
        headers: this.headers,
        signal,
      })
    } catch (error) {
      if (!signal.aborted && !(error instanceof VykorApiError && [404, 413].includes(error.status)))
        throw error
    }
  }

  private async run(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      await this.connect().catch(() => undefined)
      if (!this.shutdown.signal.aborted)
        await delay(1_000, undefined, { signal: this.shutdown.signal, ref: false }).catch(() => undefined)
    }
  }
}
