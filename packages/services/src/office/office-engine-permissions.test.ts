import { afterEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ readFile: vi.fn(), access: vi.fn(), chmod: vi.fn() }));
vi.mock("node:fs/promises", () => io);
import { createOfficeRunner, hash, OFFICE_ASSETS } from "./office-engine.mjs";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", arch);
  vi.resetAllMocks();
});
it.each(["darwin-arm64", "linux-x64"])("repairs executable permissions only after verification on %s", async target => {
  const [os, cpu] = target.split("-");
  Object.defineProperty(process, "platform", { value: os, configurable: true });
  Object.defineProperty(process, "arch", { value: cpu, configurable: true });
  const asset = OFFICE_ASSETS[target]!;
  const original = asset[1];
  asset[1] = hash(Buffer.from("fixture"));
  try {
    io.readFile.mockResolvedValue(Buffer.from("tampered"));
    await expect(createOfficeRunner({ binaryPath: `/${target}/bad` } as never)).rejects.toThrow("校验失败");
    expect(io.chmod).not.toHaveBeenCalled();
    io.readFile.mockResolvedValue(Buffer.from("fixture"));
    io.access.mockRejectedValueOnce(new Error("not executable"));
    await createOfficeRunner({ binaryPath: `/${target}/good` } as never);
    expect(io.chmod).toHaveBeenCalledWith(`/${target}/good`, 0o755);
    io.chmod.mockClear();
    io.access.mockResolvedValueOnce(undefined);
    await createOfficeRunner({ binaryPath: `/${target}/readonly-executable` } as never);
    expect(io.chmod).not.toHaveBeenCalled();
  } finally { asset[1] = original; }
});
