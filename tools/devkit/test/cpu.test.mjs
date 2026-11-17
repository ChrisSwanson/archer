// node --test tools/devkit/test/cpu.test.mjs
// splitProfile: a URL-less native frame (getBoundingClientRect) is charged to whoever called it (rubric
// docs/quality/rubrics/performance.md S3, §8 "fix tools/devkit/harness/cpu.mjs counting native DOM frames as harness time").
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitProfile } from "../harness/cpu.mjs";

const origin = "http://127.0.0.1:1";
// (root) → app commit → getBoundingClientRect (native, no URL)
// (root) → __playwright_evaluation_script__ query → getBoundingClientRect
// (root) → anonymous evaluate with no URL at all → getComputedStyle
const profile = {
  nodes: [
    { id: 1, callFrame: { url: "", functionName: "(root)" }, children: [2, 4, 6, 8] },
    {
      id: 2,
      callFrame: { url: `${origin}/assets/app.js`, functionName: "commitLayout", lineNumber: 9 },
      children: [3],
    },
    { id: 3, callFrame: { url: "", functionName: "getBoundingClientRect", lineNumber: -1 } },
    {
      id: 4,
      callFrame: { url: "__playwright_evaluation_script__1", functionName: "query", lineNumber: 0 },
      children: [5],
    },
    { id: 5, callFrame: { url: "", functionName: "getBoundingClientRect", lineNumber: -1 } },
    { id: 6, callFrame: { url: "", functionName: "probe", lineNumber: 0 }, children: [7] },
    { id: 7, callFrame: { url: "", functionName: "getComputedStyle", lineNumber: -1 } },
    { id: 8, callFrame: { url: "", functionName: "(program)" } },
  ],
  samples: [3, 3, 3, 5, 7, 8, 1],
  timeDeltas: [1000, 1000, 1000, 2000, 500, 300, 4000],
};

test("a native DOM frame under an app frame counts as app time; under harness code, as harness", () => {
  const s = splitProfile(profile, origin);
  assert.equal(s.appMs, 3, "3 ms of getBoundingClientRect inside commitLayout is the page's work");
  assert.equal(s.harnessMs, 2.5, "the Playwright query's layout and the URL-less probe's style stay harness");
  assert.equal(s.browserMs, 0.3);
  assert.match(
    s.topApp[0],
    /getBoundingClientRect \(in commitLayout app\.js:10\)/,
    "the native frame is named with the frame that called it",
  );
});

test("the frames charged by no URL at all stay visible", () => {
  const s = splitProfile(profile, origin);
  assert.equal(s.unresolvedMs, 0.5, "only getComputedStyle under the URL-less probe had no URL'd ancestor");
  assert.equal(s.resolvedNativeMs, 5, "native frames charged through an ancestor with a URL (3 app + 2 harness)");
});
