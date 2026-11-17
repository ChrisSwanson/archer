import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { removeTempDirs, tempDir } from "../project/support.ts";
import { snapshotUiDist } from "./ui-dist.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs();
});

test("bundle tests snapshot the explicit scratch page and its worker bytes", async () => {
  const page = '<html><script src="page-assets/elk-layout-worker-Scratch.js"></script></html>';
  const worker = "self.onmessage = () => {};\n";
  const root = tempDir({
    "scratch/index.html": page,
    "scratch/mcp/index.html": "<html>MCP scratch page</html>",
    "scratch/page-assets/elk-layout-worker-Scratch.js": worker,
  });
  vi.stubEnv("ARCHER_PAGE", join(root, "scratch/index.html"));
  const copy = join(root, "copy");
  expect(await snapshotUiDist(copy, 1)).toBe(copy);
  expect(readFileSync(join(copy, "index.html"), "utf8")).toBe(page);
  expect(readFileSync(join(copy, "mcp/index.html"), "utf8")).toBe("<html>MCP scratch page</html>");
  expect(readFileSync(join(copy, "page-assets/elk-layout-worker-Scratch.js"), "utf8")).toBe(worker);
});
