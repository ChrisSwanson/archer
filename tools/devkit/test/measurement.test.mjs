import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMeasurement } from "../harness/measurement.mjs";

test("a passing probe cannot hide a harness execution failure", async () => {
  const server = createServer((req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end("<main>Known measurement page</main>"),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = mkdtempSync(join(tmpdir(), "archer-measurement-test-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const measure = async (page) => {
      await page.evaluate(() => console.error("planted execution failure"));
      return { pass: true, status: "pass", counts: { samples: 1 } };
    };
    const r = await runMeasurement({ name: "planted", url, out, measure });
    assert.equal(r.harness.ok, false);
    assert.equal(r.pass, false);
    assert.equal(r.status, "incomplete");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});

// O151: whatever throws in withPage before the run's own try closes the browser, so the process ends. Run in a child:
// an open browser would keep it alive, and the test would see the timeout, not the exit.
test("a withPage setup that throws closes the browser, and the process ends", async () => {
  const { spawnSync } = await import("node:child_process");
  const harness = new URL("../harness/index.mjs", import.meta.url).href;
  const script = `const {withPage}=await import(${JSON.stringify(harness)});
    await withPage(async()=>{}, {name:'setup-throws', sandbox:{name:'external',origin:'http://127.0.0.1:9',url:'http://127.0.0.1:9/',link:'http://127.0.0.1:9/',projects:[]}, login:false, viewport:{width:-1,height:-1}})
      .then(()=>{console.log('resolved');process.exitCode=3;}, (e)=>console.log('rejected', String(e.message).split('\\n')[0]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error?.code, undefined, `the process did not end by itself (${r.error?.code}); stdout ${r.stdout}`);
  assert.equal(r.signal, null);
  assert.match(r.stdout, /^rejected /m);
});
