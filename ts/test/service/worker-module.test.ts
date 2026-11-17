import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("source compile and layout workers inherit an existing tsx loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-worker-loader-"));
  try {
    const script = join(dir, "check.mjs");
    const compiler = new URL("../../src/service/compile-pool.ts", import.meta.url).href;
    const layout = new URL("../../src/measurement/pool.ts", import.meta.url).href;
    writeFileSync(
      script,
      `
      import { CompilePool } from ${JSON.stringify(compiler)};
      import { LayoutPool } from ${JSON.stringify(layout)};
      // The budget is not what this checks: a cold worker loading TypeScript through tsx overran 3 s on a slow runner.
      const compiler = new CompilePool(), layout = new LayoutPool({ workerMs: 60_000, deadlineMs: 60_000 });
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const source = "flowchart LR\\n a[Client] edge@--> b[API]\\n";
        const compiled = await compiler.compile(source);
        const measured = await layout.request({ envelope: null, compilation: {
          source, view: { id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd", registration: "ephemeral" }
        }});
        console.log(JSON.stringify({ threaded: compiler.threaded, model: compiled.model?.type, measured: measured.status }));
      } finally { clearInterval(keepAlive); compiler.close(); layout.close(); }
    `,
    );
    const result = execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(JSON.parse(result)).toEqual({ threaded: true, model: "freeform-graph", measured: "ready" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source workers return complete geometry when an eval parent inherits --input-type=module", () => {
  const compiler = new URL("../../src/service/compile-pool.ts", import.meta.url).href;
  const layout = new URL("../../src/measurement/pool.ts", import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module",
      "--eval",
      `
      import { CompilePool } from ${JSON.stringify(compiler)};
      import { LayoutPool } from ${JSON.stringify(layout)};
      // The budget is not what this checks: a cold worker loading TypeScript through tsx overran 3 s on a slow runner.
      const compiler = new CompilePool(), layout = new LayoutPool({ workerMs: 60_000, deadlineMs: 60_000 });
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const source = "flowchart LR\\n a[Client] edge@--> b[API]\\n";
        const compiled = await compiler.compile(source);
        const measured = await layout.request({ envelope: null, compilation: {
          source, view: { id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd", registration: "ephemeral" }
        }});
        console.log(JSON.stringify({ threaded: compiler.threaded, model: compiled.model?.type, measured }));
      } finally { clearInterval(keepAlive); compiler.close(); layout.close(); }
    `,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  const outcome = JSON.parse(result);
  expect(outcome.measured).toMatchObject({ status: "ready", complete: true });
  expect(outcome.measured.geometry.states).toHaveLength(1);
  expect(outcome.measured.geometry.states[0].bounds.width).toBeGreaterThan(0);
  expect(outcome.measured.geometry.states[0].bounds.height).toBeGreaterThan(0);
  expect(outcome).toMatchObject({ threaded: true, model: "freeform-graph" });
}, 130_000);
