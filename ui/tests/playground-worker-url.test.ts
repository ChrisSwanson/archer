// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.mock("../src/layout/elk-layout-worker?worker&url", () => ({ default: "" }));
const { layoutWorkerUrl } = await import("../src/playground/worker");

it.each(["/", "/archer/"])("resolves the layout worker beside the public document at %s", (base) => {
  const document = `https://examples.invalid${base}playground/app/index.html?route=%2Fprojects%2F`;
  // A relative-base build names it from its chunk, absolute at run time; a relative name resolves from the document.
  const chunk = new URL(
    "../page-assets/elk-layout-worker-a1.js",
    `https://examples.invalid${base}playground/app/assets/x.js`,
  );
  expect(layoutWorkerUrl(chunk.href, document)).toBe(
    `https://examples.invalid${base}playground/app/page-assets/elk-layout-worker-a1.js`,
  );
  expect(layoutWorkerUrl("page-assets/elk-layout-worker-a1.js", document)).toBe(
    `https://examples.invalid${base}playground/app/page-assets/elk-layout-worker-a1.js`,
  );
});

it("hands the first layout request the worker the entry started early, then starts new ones", async () => {
  const made: string[] = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor(public url: string) {
        made.push(url);
      }
    },
  );
  const { createLayoutWorker, startLayoutWorker } = await import("../src/playground/worker");
  // The entry starts it before the App boots, so its 470 KB download runs beside the data and the view's chunks.
  const early = startLayoutWorker();
  expect(made).toHaveLength(1);
  expect(startLayoutWorker()).toBe(early);
  expect(createLayoutWorker()).toBe(early);
  expect(made).toHaveLength(1);
  // A later transport (the first one closed after a failure) gets a fresh worker, never the spent one.
  expect(createLayoutWorker()).not.toBe(early);
  expect(made).toHaveLength(2);
  vi.unstubAllGlobals();
});
