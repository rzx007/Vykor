import { describe, expect, it } from "vitest";

import { computeNextScheduledTime, parseRRule } from "../recurrence.js";

describe("scheduled recurrence", () => {
  it("returns a future one-time occurrence", () => {
    expect(
      computeNextScheduledTime(
        { format: "once", value: "2026-08-19T09:00:00+08:00" },
        { after: new Date("2026-08-18T00:00:00Z") },
      ),
    ).toBe(Date.parse("2026-08-19T09:00:00+08:00"));
  });

  it("finds the next weekday morning in the requested timezone", () => {
    const next = computeNextScheduledTime(
      {
        format: "rrule",
        value: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
      },
      {
        after: new Date("2026-08-21T02:00:00Z"),
        anchor: new Date("2026-08-18T01:00:00Z"),
        timezone: "Asia/Shanghai",
      },
    );
    expect(new Date(next).toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("supports minute-based follow-up loops", () => {
    const next = computeNextScheduledTime(
      { format: "rrule", value: "RRULE:FREQ=MINUTELY;INTERVAL=10" },
      {
        after: new Date("2026-08-18T00:06:00Z"),
        anchor: new Date("2026-08-18T00:00:00Z"),
      },
    );
    expect(new Date(next).toISOString()).toBe("2026-08-18T00:10:00.000Z");
  });

  it("rejects unsupported recurrence frequencies", () => {
    expect(() => parseRRule("RRULE:FREQ=YEARLY")).toThrow(/FREQ/);
  });
});
