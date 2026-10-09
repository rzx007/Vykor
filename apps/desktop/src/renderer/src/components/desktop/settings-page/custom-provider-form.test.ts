import { describe, expect, it } from "vitest"

import { validateCustomProviderForm } from "./custom-provider-form"

const validForm = {
  id: "office-gateway",
  displayName: " Office Gateway ",
  baseUrl: "https://gateway.example/v1",
  apiKey: " secret ",
  models: [
    {
      key: "model-1",
      id: "team-model",
      displayName: " Team Model ",
      imageInputSupport: "native" as const,
      contextWindow: "",
      maxOutputTokens: "",
    },
  ],
  headers: [{ key: "header-1", name: " X-Tenant ", value: " desktop " }],
}

describe("validateCustomProviderForm", () => {
  it("normalizes a valid custom provider form", () => {
    expect(validateCustomProviderForm(validForm)).toEqual({
      ok: true,
      value: {
        id: "office-gateway",
        displayName: "Office Gateway",
        baseUrl: "https://gateway.example/v1",
        apiFormat: "openai",
        apiKey: "secret",
        models: [
          {
            id: "team-model",
            displayName: "Team Model",
            imageInputSupport: "native",
          },
        ],
        headers: { "X-Tenant": "desktop" },
      },
    })
  })

  it("rejects an invalid provider ID", () => {
    expect(validateCustomProviderForm({ ...validForm, id: "Open AI" })).toEqual({
      ok: false,
      field: "id",
      message: "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
    })
  })

  it("requires at least one complete model", () => {
    expect(validateCustomProviderForm({ ...validForm, models: [] })).toEqual({
      ok: false,
      field: "models",
      message: "请至少添加一个模型。",
    })
    expect(
      validateCustomProviderForm({
        ...validForm,
        models: [
          {
            key: "model-1",
            id: "",
            displayName: "Empty",
            imageInputSupport: "unknown",
            contextWindow: "",
            maxOutputTokens: "",
          },
        ],
      })
    ).toMatchObject({ ok: false, field: "models" })
  })

  it("rejects duplicate model IDs and incomplete header rows", () => {
    expect(
      validateCustomProviderForm({
        ...validForm,
        models: [
          {
            key: "model-1",
            id: "same",
            displayName: "One",
            imageInputSupport: "unknown",
            contextWindow: "",
            maxOutputTokens: "",
          },
          {
            key: "model-2",
            id: "same",
            displayName: "Two",
            imageInputSupport: "unsupported",
            contextWindow: "",
            maxOutputTokens: "",
          },
        ],
      })
    ).toMatchObject({ ok: false, field: "models" })
    expect(
      validateCustomProviderForm({
        ...validForm,
        headers: [{ key: "header-1", name: "X-Tenant", value: "" }],
      })
    ).toMatchObject({ ok: false, field: "headers" })
  })

  it("keeps unsupported and unknown image declarations instead of guessing from IDs", () => {
    expect(
      validateCustomProviderForm({
        ...validForm,
        models: [
          {
            key: "model-1",
            id: "gpt-4o",
            displayName: "Vision off",
            imageInputSupport: "unsupported",
            contextWindow: "",
            maxOutputTokens: "",
          },
          {
            key: "model-2",
            id: "custom-vl",
            displayName: "Unknown",
            imageInputSupport: "unknown",
            contextWindow: "",
            maxOutputTokens: "",
          },
        ],
      })
    ).toMatchObject({
      ok: true,
      value: {
        models: [
          { id: "gpt-4o", displayName: "Vision off", imageInputSupport: "unsupported" },
          { id: "custom-vl", displayName: "Unknown", imageInputSupport: "unknown" },
        ],
      },
    })
  })

  it("passes through user typed context and output limits", () => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [
        {
          key: "model-1",
          id: "team-model",
          displayName: "Team Model",
          imageInputSupport: "native" as const,
          contextWindow: " 200000 ",
          maxOutputTokens: "64000",
        },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        models: [
          {
            id: "team-model",
            displayName: "Team Model",
            imageInputSupport: "native",
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        ],
      },
    })
  })

  it("omits a limit left blank so the server can auto match it", () => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [
        {
          key: "model-1",
          id: "team-model",
          displayName: "Team Model",
          imageInputSupport: "native" as const,
          contextWindow: "128000",
          maxOutputTokens: "   ",
        },
      ],
    })

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.value.models[0]).toEqual({
        id: "team-model",
        displayName: "Team Model",
        imageInputSupport: "native",
        contextWindow: 128_000,
      })
    }
  })

  it("rejects limits that are not positive integers", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e6"]) {
      expect(
        validateCustomProviderForm({
          ...validForm,
          models: [
            {
              key: "model-1",
              id: "team-model",
              displayName: "Team Model",
              imageInputSupport: "native" as const,
              contextWindow: bad,
              maxOutputTokens: "",
            },
          ],
        })
      ).toMatchObject({ ok: false, field: "models" })
    }
  })
})
