import { afterEach, expect, it, vi } from "vitest";
import { loadCodexCredential } from "@vykor/auth";
import { createCodexModelList } from "../codex-model-list.js";

vi.mock("@vykor/auth", () => ({
  loadCodexCredential: vi.fn(),
  isCredentialExpired: () => false,
}));
vi.mock("@vykor/api", () => ({ buildCodexHeaders: () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

it("uses only the current login's last successful list on network failures", async () => {
  const login = (value: string) => vi.mocked(loadCodexCredential).mockResolvedValue({
    value, sourcePath: "auth.json", provider: "codex", authKind: "auth_token", managedBy: "fixture",
  });
  login("first");
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  const list = createCodexModelList();
  const model = { slug: "official-model", display_name: "Official", visibility: "list" };
  const success = () => fetch.mockResolvedValueOnce(Response.json({ models: [model, { ...model, visibility: "hide" }] }));
  success();
  expect(await list()).toEqual([{ id: "official-model", name: "Official" }]);
  expect(await list()).toHaveLength(1);
  fetch.mockResolvedValueOnce(Response.json({ models: [] }));
  expect(await list()).toEqual([]);
  expect(await list()).toEqual([]);
  success();
  expect(await list()).toHaveLength(1);
  fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(await list()).toEqual([]);
  expect(await list()).toEqual([]);
  success();
  expect(await list()).toHaveLength(1);
  login("second");
  expect(await list()).toEqual([]);
});
