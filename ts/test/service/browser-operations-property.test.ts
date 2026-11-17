import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("page operation boundary is refused or valid on a small stack against a deadline", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-browser-boundary-"));
  try {
    const entry = join(scratch, "probe.ts"),
      output = join(scratch, "probe.mjs");
    writeFileSync(
      entry,
      `import {parseBrowserOperation,BrowserOperationRefusal,BROWSER_OPERATIONS} from ${JSON.stringify(new URL("../../src/service/browser-operations.ts", import.meta.url).pathname)};
let seed=1947;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
const vocabulary=[...BROWSER_OPERATIONS,"name","arguments","viewId","from","to","HEAD",null,true,0,{},[]];
const values=[];for(let n=0;n<1000;n++){const a=vocabulary[random()%vocabulary.length],b=vocabulary[random()%vocabulary.length];values.push(a,{name:a,arguments:b},{name:BROWSER_OPERATIONS[n%4],arguments:{viewId:"flow",extra:b}},{name:BROWSER_OPERATIONS[n%4],arguments:n%2?{}:null});}
let deep={};for(let n=0;n<6000;n++)deep={next:deep};values.push({name:"compare_diagrams",arguments:deep});const cycle={};cycle.next=cycle;values.push({name:"compare_diagrams",arguments:cycle});
let accepted=0;for(const value of values){try{const result=parseBrowserOperation(value);if(!BROWSER_OPERATIONS.includes(result.name)||!result.arguments)throw Error("invalid accepted result");accepted++;}catch(error){if(!(error instanceof BrowserOperationRefusal))throw error;}}
if(!accepted)throw Error("no valid vocabulary inputs exercised");console.log("PASS",values.length,accepted);`,
    );
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const child = spawnSync(process.execPath, ["--stack_size=128", output], { encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/^PASS 4002 /);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
