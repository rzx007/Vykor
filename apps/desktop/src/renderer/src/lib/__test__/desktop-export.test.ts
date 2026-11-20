// @vitest-environment jsdom
import { expect, it } from "vitest"
import { collectLegacyBusinessSources, legacyDigest } from "../business-data"
it("scans all supported keys including composer and zero keys without exporting preferences or bodies", async () => {
  localStorage.clear()
  localStorage.setItem("window-preference", "PRIVATE PREFERENCE")
  expect(await collectLegacyBusinessSources()).toEqual({})
  const composer = '{"private":"PRIVATE COMPOSER"}', image = '["PRIVATE IMAGE"]'
  localStorage.setItem("vykor.desktop.composer-recovery.v1", composer)
  localStorage.setItem(`vykor-image-annotations-v1:${"a".repeat(64)}`, image)
  localStorage.setItem("vykor-image-annotations-v1:../../bad", "PRIVATE BAD")
  const sources = await collectLegacyBusinessSources()
  expect(sources).toEqual({ composer: await legacyDigest(composer), [`image-annotations:${"a".repeat(64)}`]: await legacyDigest(image) })
  expect(JSON.stringify(sources)).not.toContain("PRIVATE")
  expect(localStorage.length).toBe(4)
})
