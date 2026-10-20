// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

vi.mock("@renderer/components/desktop/pet-page/pet-page", () => ({
  PetWindow: () => null,
}))

describe("pet route", () => {
  it("dismisses the HTML splash before the pet window renders", async () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <div id="startup-loading">splash</div>
    `

    const { Route } = await import("./pet")
    await Route.options.beforeLoad?.({} as never)

    expect(document.getElementById("startup-loading")).toBeNull()
  })
})
