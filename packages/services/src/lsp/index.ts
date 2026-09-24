import { readFile } from "node:fs/promises";
import type { Settings } from "@vykor/core";
import { createProcess, SandboxUnavailableError } from "@vykor/sandbox";

export interface LspServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  sessionId?: string;
  settings?: Settings;
  signal?: AbortSignal;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
  signature?: string;
  docstring?: string;
}

export interface HoverInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
  signature?: string;
  docstring?: string;
}

export class LspClient {
  private config: LspServerConfig;
  private connected = false;

  constructor(config: LspServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async documentSymbols(filePath: string): Promise<SymbolInfo[]> {
    const content = await readFile(filePath, "utf-8").catch(() => "");
    if (!content) return [];
    return this.extractSymbols(content, filePath);
  }

  async workspaceSymbolSearch(root: string, query: string): Promise<SymbolInfo[]> {
    if (!query) return [];
    try {
      const stdout = await this.runRipgrep(root, [
        "--no-heading",
        "-n",
        query,
        "--type-add",
        "source:*.{ts,js,py}",
        "-t",
        "source",
        "-g",
        "*.ts",
        "-g",
        "*.js",
        "-g",
        "*.py",
        "--max-count",
        "5",
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 20)
        .map((line) => {
          const [file, lineStr, ...rest] = line.split(":");
          return {
            name: rest.join(":").trim().slice(0, 80),
            kind: "match",
            path: file ?? "",
            line: parseInt(lineStr ?? "0", 10),
            character: 0,
          };
        });
    } catch (error) {
      if (error instanceof SandboxUnavailableError) throw error;
      return [];
    }
  }

  async hover(
    _root: string,
    _filePath: string,
    _symbol?: string,
    _line?: number,
    _character?: number
  ): Promise<HoverInfo | null> {
    return null;
  }

  async findReferences(
    root: string,
    filePath: string,
    symbol?: string,
    line?: number
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!symbol) return [];
    try {
      const stdout = await this.runRipgrep(root, [
        "--no-heading",
        "-n",
        symbol,
        "-g",
        "*.ts",
        "-g",
        "*.js",
        "-g",
        "*.py",
        "--max-count",
        "20",
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [file, lineStr, ...rest] = l.split(":");
          return { path: file ?? "", line: parseInt(lineStr ?? "0", 10), text: rest.join(":") };
        });
    } catch (error) {
      if (error instanceof SandboxUnavailableError) throw error;
      return [];
    }
  }

  async goToDefinition(
    root: string,
    filePath: string,
    symbol?: string,
    line?: number
  ): Promise<SymbolInfo[]> {
    if (!symbol) return [];
    const refs = await this.findReferences(root, filePath, symbol, line);
    return refs.map((r) => ({
      name: symbol,
      kind: "definition",
      path: r.path,
      line: r.line,
      character: 0,
    }));
  }

  private extractSymbols(content: string, filePath: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const patterns = [
      { regex: /^(export\s+)?(async\s+)?function\s+(\w+)/gm, kind: "function" },
      { regex: /^(export\s+)?(abstract\s+)?class\s+(\w+)/gm, kind: "class" },
      { regex: /^(export\s+)?(const|let|var)\s+(\w+)/gm, kind: "variable" },
      { regex: /^(export\s+)?interface\s+(\w+)/gm, kind: "interface" },
      { regex: /^(export\s+)?type\s+(\w+)/gm, kind: "type" },
      { regex: /^def\s+(\w+)/gm, kind: "function" },
      { regex: /^class\s+(\w+)/gm, kind: "class" },
    ];

    for (const { regex, kind } of patterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const name = match[match.length - 1];
        if (name) {
          const line = content.slice(0, match.index).split("\n").length;
          symbols.push({ name, kind, path: filePath, line, character: match.index });
        }
      }
    }
    return symbols;
  }

  private async runRipgrep(root: string, args: string[]): Promise<string> {
    const child = await createProcess(["rg", ...args], {
      cwd: root,
      sessionId: this.config.sessionId,
      settings: this.config.settings,
      signal: this.config.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(0, 1024 * 1024);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(0, 1024 * 1024);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `rg exited with code ${code ?? 1}`));
      });
    });
  }
}
