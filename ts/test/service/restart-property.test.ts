import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("restart settings boundary is refused or valid on a small stack against a deadline", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-restart-boundary-"));
  try {
    const entry = join(scratch, "probe.ts"),
      output = join(scratch, "probe.mjs");
    writeFileSync(
      entry,
      `import {parseRestartConfiguration} from ${JSON.stringify(new URL("../../src/service/restart.ts", import.meta.url).pathname)};
import {ServiceUnavailableError} from ${JSON.stringify(new URL("../../src/service/service-client.ts", import.meta.url).pathname)};
let seed=831;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
const valid={serviceName:'default',stateDir:'/tmp/state',socketPath:'/tmp/socket',host:'127.0.0.1',port:40399,restoreState:true,launchEnv:{HOME:'/tmp'}};
const vocabulary=[null,true,false,0,1,40399,65536,'',{},[],...Object.keys(valid),'HOME','ARCHER_CONFIG','default','/tmp','nul\\0value',valid];
const values=[valid];for(let n=0;n<1200;n++){const a=vocabulary[random()%vocabulary.length],b=vocabulary[random()%vocabulary.length];values.push(a,{[String(a)]:b},{...valid,[Object.keys(valid)[random()%Object.keys(valid).length]]:b});}
let deep={};for(let n=0;n<6000;n++)deep={next:deep};values.push({...valid,launchEnv:{HOME:deep}});const cycle={};cycle.next=cycle;values.push({...valid,launchEnv:{HOME:cycle}});
let accepted=0;for(const value of values){try{const result=parseRestartConfiguration(value);if(!result.serviceName||!Number.isInteger(result.port)||result.port<1||result.port>65535||typeof result.restoreState!=='boolean')throw Error('invalid accepted result');accepted++;}catch(error){if(!(error instanceof ServiceUnavailableError))throw error;}}
if(!accepted)throw Error('no valid inputs exercised');console.log('PASS',values.length,accepted);`,
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
    expect(child.stdout).toMatch(/^PASS 3603 /u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
