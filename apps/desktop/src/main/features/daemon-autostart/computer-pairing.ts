import type { ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { ServiceEndpoint } from "@rzx/client/service"
import { resolveUserDataPaths } from "@vykor/host-config/paths"

type PairingIdentity = {
  pid: number
  startedAt: number
  url: string
  storePath: string
  dataRoot: string
}
type RegisteredIdentity = Omit<PairingIdentity, "dataRoot">

const challengeType = "vykor-computer-pair"
const responseType = "vykor-computer-paired"

function matchesIdentity(value: Record<string, unknown>, expected: PairingIdentity): boolean {
  return Object.entries(expected).every(([key, field]) => value[key] === field)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** Runs only in the actual child with an inherited Node IPC channel. */
export function createDesktopComputerPairing(dataRoot: string) {
  if (!process.connected || !process.send) return undefined
  const token = randomBytes(32).toString("hex")
  return {
    token,
    publish(registration: RegisteredIdentity): void {
      if (!process.connected) return
      const identity: PairingIdentity = {
        pid: registration.pid,
        startedAt: registration.startedAt,
        url: registration.url,
        storePath: registration.storePath,
        dataRoot,
      }
      const receive = (message: unknown) => {
        process.removeListener("disconnect", remove)
        const request = asRecord(message)
        if (
          request.type !== challengeType ||
          typeof request.nonce !== "string" ||
          !/^[\da-f-]{36}$/u.test(request.nonce) ||
          !matchesIdentity(request, identity) ||
          !process.connected
        )
          return
        process.send?.({ type: responseType, nonce: request.nonce, ...identity, token }, () => {})
      }
      const remove = () => {
        process.removeListener("message", receive)
      }
      process.once("message", receive)
      process.once("disconnect", remove)
    },
  }
}

/** Runs after SDK discovery authenticated the exact spawned child registration. */
export function pairDesktopComputerDaemon(
  child: ChildProcess,
  endpoint: ServiceEndpoint,
  dataRoot: string,
  startupSignal: AbortSignal
): Promise<string | undefined> {
  const canonical = resolveUserDataPaths(dataRoot)
  if (
    !isAbsolute(dataRoot) ||
    !child.connected ||
    endpoint.pid !== child.pid ||
    endpoint.file !== canonical.daemonRegistryFilePath ||
    endpoint.storePath !== canonical.sessionsDatabasePath
  )
    return Promise.resolve(undefined)
  const identity: PairingIdentity = {
    pid: endpoint.pid,
    startedAt: endpoint.startedAt,
    url: endpoint.url,
    storePath: endpoint.storePath,
    dataRoot: resolve(dataRoot),
  }
  const nonce = randomUUID()
  const signal = AbortSignal.any([startupSignal, AbortSignal.timeout(2_000)])
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolveReply) => {
    const finish = (token?: string) => {
      child.removeListener("message", receive)
      child.removeListener("disconnect", disconnected)
      signal.removeEventListener("abort", disconnected)
      resolveReply(token)
    }
    const receive = (message: unknown) => {
      const reply = asRecord(message)
      finish(
        reply.type === responseType &&
          reply.nonce === nonce &&
          matchesIdentity(reply, identity) &&
          typeof reply.token === "string" &&
          /^[a-f\d]{64}$/u.test(reply.token)
          ? reply.token
          : undefined
      )
    }
    const disconnected = () => finish()
    child.once("message", receive)
    child.once("disconnect", disconnected)
    signal.addEventListener("abort", disconnected, { once: true })
    child.send({ type: challengeType, nonce, ...identity }, (error) => {
      if (error) finish()
    })
  })
}
