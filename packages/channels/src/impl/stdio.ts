import type { ChannelAdapter, ChannelMessage } from "../index";

export class StdioAdapter implements ChannelAdapter {
  name = "stdio";
  private handler?: (message: ChannelMessage) => void | Promise<void>;

  async connect(): Promise<void> { }

  async disconnect(): Promise<void> { }

  async send(message: ChannelMessage): Promise<void> {
    process.stdout.write(`${message.content}\n`);
  }

  onMessage(handler: (message: ChannelMessage) => void | Promise<void>): void {
    this.handler = handler;
    const readline = require("node:readline") as typeof import("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line: string) => {
      if (this.handler) {
        void this.handler({
          id: `stdio_${Date.now()}`,
          channel: "stdio",
          sender: "user",
          content: line,
          timestamp: new Date(),
        });
      }
    });
  }
}
