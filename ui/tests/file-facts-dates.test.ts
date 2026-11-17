// Date cells format with cached Intl formatters (perf #8) and say exactly what `toLocale*String` said.
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const NOW = Date.parse("2026-10-19T15:30:00");
const SAMPLES = [
  "2026-10-19T09:05:00",
  "2026-10-18T23:59:00",
  "2026-03-02T12:00:00",
  "2025-12-31T08:00:00",
  "2019-07-04T17:45:00",
  "not a date",
];

it("formats like toLocale*String, Invalid Date included", async () => {
  const { shortDate, longDate } = await import("../src/app/file-facts");
  for (const iso of SAMPLES) {
    const date = new Date(iso),
      today = new Date(NOW);
    const expectedShort =
      date.toDateString() === today.toDateString()
        ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString(
            undefined,
            date.getFullYear() === today.getFullYear() && Math.abs(NOW - date.getTime()) < 300 * 86_400_000
              ? { day: "numeric", month: "short" }
              : { day: "numeric", month: "short", year: "numeric" },
          );
    expect(shortDate(iso, NOW)).toBe(expectedShort);
    expect(longDate(iso)).toBe(date.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }));
  }
});

it("a table of dates makes each formatter once, not once per cell", async () => {
  vi.resetModules();
  const { shortDate, longDate } = await import("../src/app/file-facts");
  const Real = Intl.DateTimeFormat;
  let made = 0;
  Intl.DateTimeFormat = class extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      made++;
    }
  } as typeof Real;
  const toLocale = ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].map((name) =>
    vi.spyOn(Date.prototype, name as "toLocaleString"),
  );
  for (let row = 0; row < 200; row++)
    for (const iso of SAMPLES.slice(0, -1)) {
      shortDate(iso, NOW);
      longDate(iso);
    }
  Intl.DateTimeFormat = Real;
  expect(made).toBeLessThanOrEqual(4);
  for (const spy of toLocale) expect(spy).not.toHaveBeenCalled();
});
