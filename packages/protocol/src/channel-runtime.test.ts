import { describe, expect, it } from "vitest";

import {
  parseChannelRuntimeControlInput,
  parseFeishuAllowInput,
  parseFeishuConnectInput,
  parseFeishuPatchInput,
  parseFeishuRegistrationStartInput,
} from "./channel-runtime.js";

describe("parseChannelRuntimeControlInput", () => {
  it("accepts an empty body and a connector", () => {
    expect(parseChannelRuntimeControlInput(undefined)).toEqual({});
    expect(parseChannelRuntimeControlInput({})).toEqual({});
    expect(parseChannelRuntimeControlInput({ connector: "feishu" })).toEqual({
      connector: "feishu",
    });
  });

  it("omits a blank connector", () => {
    expect(parseChannelRuntimeControlInput({ connector: "  " })).toEqual({});
  });

  it("rejects non-object bodies and non-string connectors", () => {
    expect(() => parseChannelRuntimeControlInput([])).toThrow(/must be an object/);
    expect(() => parseChannelRuntimeControlInput({ connector: 1 })).toThrow(
      /connector must be a string/,
    );
  });
});

describe("parseFeishuConnectInput", () => {
  it("requires appId and appSecret", () => {
    expect(parseFeishuConnectInput({ appId: "cli_x", appSecret: "sec" })).toEqual({
      appId: "cli_x",
      appSecret: "sec",
    });
    expect(() => parseFeishuConnectInput({ appSecret: "sec" })).toThrow(/appId is required/);
    expect(() => parseFeishuConnectInput({ appId: "cli_x" })).toThrow(/appSecret is required/);
  });

  it("accepts only known domains", () => {
    expect(
      parseFeishuConnectInput({ appId: "cli_x", appSecret: "sec", domain: "lark" }),
    ).toEqual({ appId: "cli_x", appSecret: "sec", domain: "lark" });
    expect(() =>
      parseFeishuConnectInput({ appId: "cli_x", appSecret: "sec", domain: "x" }),
    ).toThrow(/domain must be feishu or lark/);
  });
});

describe("parseFeishuAllowInput", () => {
  it("requires an ou_/oc_ id and drops a blank name", () => {
    expect(parseFeishuAllowInput({ id: "ou_1" })).toEqual({ id: "ou_1" });
    expect(parseFeishuAllowInput({ id: "oc_1", name: "  " })).toEqual({ id: "oc_1" });
    expect(parseFeishuAllowInput({ id: "ou_1", name: " 个人 " })).toEqual({
      id: "ou_1",
      name: "个人",
    });
  });

  it("rejects ids outside ou_/oc_", () => {
    expect(() => parseFeishuAllowInput({ id: "*" })).toThrow(/id must start with ou_ or oc_/);
    expect(() => parseFeishuAllowInput({ id: "ou_1|ou_2" })).toThrow(
      /id must start with ou_ or oc_/,
    );
  });
});

describe("parseFeishuPatchInput", () => {
  it("accepts at least one known boolean key", () => {
    expect(parseFeishuPatchInput({ enabled: false })).toEqual({ enabled: false });
    expect(parseFeishuPatchInput({ sendProgress: true, sendToolHints: false })).toEqual({
      sendProgress: true,
      sendToolHints: false,
    });
  });

  it("rejects empty patches, unknown keys and non-boolean values", () => {
    expect(() => parseFeishuPatchInput({})).toThrow(/at least one/);
    expect(() => parseFeishuPatchInput({ appSecret: "sec" })).toThrow(/unknown field/);
    expect(() => parseFeishuPatchInput({ enabled: "yes" })).toThrow(/enabled must be a boolean/);
  });
});

describe("parseFeishuRegistrationStartInput", () => {
  it("accepts an optional known domain", () => {
    expect(parseFeishuRegistrationStartInput(undefined)).toEqual({});
    expect(parseFeishuRegistrationStartInput({ domain: "lark" })).toEqual({ domain: "lark" });
    expect(() => parseFeishuRegistrationStartInput({ domain: "x" })).toThrow(
      /domain must be feishu or lark/,
    );
  });
});
