/**
 * `ARCHER_E2E_CPU_THROTTLE=<rate>` slows every page's main thread `rate` times (Chromium's
 * `Emulation.setCPUThrottlingRate`), so a test that reads the page one step too early fails
 * here instead of on a loaded CI runner (known failures O20–O25). `npm run pr-check --
 * --stress` sets it. Off (and this file inert) when unset.
 *
 * The suite imports `test` from `@playwright/test` directly, with no shared fixture, so this
 * hooks the client's context creation instead: the listener is Playwright's own instrumentation
 * (the one its tracing uses), and it runs before a new context is handed to the test.
 */
import { createRequire } from "node:module";
import type { BrowserContext, Page } from "@playwright/test";

type Instrumentation = {
  addListener(listener: { runAfterCreateBrowserContext?: (context: BrowserContext) => Promise<void> }): void;
};

export function installCpuThrottle(value = process.env.ARCHER_E2E_CPU_THROTTLE): void {
  const rate = Number(value ?? "");
  if (!Number.isFinite(rate) || rate <= 1) return;
  const playwright = createRequire(import.meta.url)("playwright-core") as { _instrumentation?: Instrumentation };
  if (playwright._instrumentation === undefined)
    throw new Error("ARCHER_E2E_CPU_THROTTLE: this Playwright has no client instrumentation to hook");
  const throttle = async (page: Page) => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
  };
  playwright._instrumentation.addListener({
    async runAfterCreateBrowserContext(context) {
      context.on("page", (page) => {
        void throttle(page).catch(() => {});
      });
      await Promise.all(context.pages().map(throttle));
    },
  });
}
