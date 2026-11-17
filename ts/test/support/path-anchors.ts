// ARCHER_TEST_PATH_ANCHORS=1: every test in the worker runs on the D7 path anchor, as on macOS (no
// verified descriptor filesystem), so the Linux suite also proves the portable confinement. The
// import is lazy: a static one would load the seam before a test file's `vi.mock("node:fs")`, and
// the seam would keep the real fs (its fault-injection tests would then never see a fault).
import { beforeAll } from "vitest";

beforeAll(async () => {
  (await import("../../src/project/confined-fs.ts")).usePathAnchorsForTests(true);
});
