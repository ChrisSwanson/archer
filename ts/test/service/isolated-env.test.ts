// O306: a service a test starts from the process environment must not open the person's browser.
import { afterEach, expect, test, vi } from "vitest";
import { shouldOpenBrowser } from "../../src/service/browser.ts";
import { isolatedProcessEnv } from "./support.ts";

afterEach(() => vi.unstubAllEnvs());

test("an isolated test service never opens a browser, even from a desktop terminal", () => {
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
  vi.stubEnv("CI", "");
  vi.stubEnv("ARCHER_OPEN_BROWSER", "always");
  const env = isolatedProcessEnv("/tmp/home");
  expect(shouldOpenBrowser(env, "darwin")).toBe(false);
  expect(shouldOpenBrowser(env, "linux")).toBe(false);
});

test("a test of the browser policy can still choose it", () => {
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
  expect(shouldOpenBrowser(isolatedProcessEnv("/tmp/home", { ARCHER_OPEN_BROWSER: "always" }), "darwin")).toBe(true);
});
