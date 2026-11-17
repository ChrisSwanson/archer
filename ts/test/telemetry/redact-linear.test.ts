import { test, expect } from "vitest";
import { redact, redactText } from "../../src/telemetry/redact.ts";
test("linear", () => {
  const s = "%41".repeat(200000) + "!";
  const t = performance.now();
  redactText(s);
  expect(performance.now() - t).toBeLessThan(200);
  const u = "a".repeat(100000) + "%";
  const t2 = performance.now();
  redactText(u);
  expect(performance.now() - t2).toBeLessThan(200);
});

test("a token split by the pre-cut never shows in part", () => {
  const token = "ab".repeat(32); // 64 hex
  const filler = (" " + "cd".repeat(32)).repeat(80); // many tokens that shrink to [redacted]
  const out = redactText(filler + " " + token, 1000);
  expect(out).not.toMatch(/[a-f0-9]{20,}/i);
});
test("a stray % cannot hide an encoded token", () => {
  const encoded = [..."ab".repeat(32)].map((c) => "%" + c.charCodeAt(0).toString(16)).join("");
  for (const text of [`x=%%${encoded}`, `%${encoded}%`, `a%zz${encoded}`])
    expect(redactText(text)).not.toContain(encoded);
});
test("the pre-cut drops its trailing run in one backward scan, not a rescan of every run", () => {
  // A URL-safe run stopping just short of the cut: `/[…]+$/` retried it from each character (7 s at 64 KB).
  for (const max of [512, 2048, 32768]) {
    const text = `${"q".repeat(max * 2 - 2)}!q${"x".repeat(1000)}`;
    const start = performance.now();
    const out = redactText(text, max);
    expect(performance.now() - start, `max ${max}`).toBeLessThan(50);
    expect(out.startsWith("q".repeat(max))).toBe(true);
  }
  expect(redactText(`${"q ".repeat(300)}${"ab".repeat(32)}`, 256)).not.toMatch(/[a-f0-9]{8}/);
});

test("a pairing code is redacted as a URL parameter and as a named field", () => {
  expect(redactText("/-/pair?code=7KQ4-M2XD&x=1")).not.toContain("7KQ4");
  expect(JSON.stringify(redact({ pairingCode: "7KQ4-M2XD", nested: { pairing_code: "7KQ4-M2XD" } }))).not.toContain(
    "7KQ4",
  );
});
