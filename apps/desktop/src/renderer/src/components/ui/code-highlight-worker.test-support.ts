import { Worker as NodeWorker } from "node:worker_threads"
import { act } from "react"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { WorkerRequest, WorkerResponse } from "@pierre/diffs/worker"

// Run the shipped Pierre worker in a real second thread; only adapt browser messaging.
export class CodeHighlightTestWorker {
  static requests: WorkerRequest[] = []
  static hold = false
  static held: Array<() => void> = []
  static instances = new Set<CodeHighlightTestWorker>()
  private thread: NodeWorker
  constructor() {
    const workerUrl = pathToFileURL(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../node_modules/@pierre/diffs/dist/worker/worker.js"
      )
    ).href
    this.thread = new NodeWorker(
      `
      const { parentPort } = require('node:worker_threads');
      globalThis.self = { addEventListener(type, listener) {
        if (type === 'message') parentPort.on('message', data => listener({ data }));
      }};
      globalThis.postMessage = data => parentPort.postMessage(data);
      import(${JSON.stringify(workerUrl)});
    `,
      { eval: true }
    )
    CodeHighlightTestWorker.instances.add(this)
  }
  addEventListener(type: string, listener: (event: { data: WorkerResponse }) => void) {
    if (type === "message")
      this.thread.on("message", (data: WorkerResponse) => {
        const deliver = () => act(() => listener({ data }))
        if (CodeHighlightTestWorker.hold && data.type === "success" && data.requestType === "file")
          CodeHighlightTestWorker.held.push(deliver)
        else deliver()
      })
  }
  postMessage(request: WorkerRequest) {
    CodeHighlightTestWorker.requests.push(request)
    this.thread.postMessage(request)
  }
  terminate() {
    CodeHighlightTestWorker.instances.delete(this)
    void this.thread.terminate()
  }
}
