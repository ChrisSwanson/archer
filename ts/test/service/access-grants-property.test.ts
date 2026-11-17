import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("grant parser refuses or validates arbitrary, vocabulary and edited input on a small stack against a clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-grant-boundary-"));
  try {
    const entry = join(directory, "probe.ts"),
      output = join(directory, "probe.mjs");
    writeFileSync(
      entry,
      `import {parseAccessGrants,AccessGrantError} from ${JSON.stringify(new URL("../../src/service/access-grants.ts", import.meta.url).pathname)};
let seed=23;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const words=['version','grants','id','label','verifier','issuedAt','revokedAt','null','[]','{}'];
const valid=JSON.stringify({version:1,grants:[{id:'a1234567-1234-4234-8234-123456789abc',label:'Browser',verifier:'a'.repeat(64),issuedAt:'2026-10-14T00:00:00.000Z',revokedAt:null}]});
let accepted=0,count=0;
const check=(text)=>{count++;try{const result=parseAccessGrants(text);if(result.version!==1||!Array.isArray(result.grants))throw Error('invalid accepted value');accepted++;}catch(e){if(!(e instanceof AccessGrantError))throw e;}};
check(valid);check('['.repeat(30000)+'0'+']'.repeat(30000));
for(let i=0;i<1000;i++){check(String.fromCharCode(next()%65536).repeat(next()%200));check(JSON.stringify({[words[next()%words.length]]:words[next()%words.length]}));const at=next()%valid.length;check(valid.slice(0,at)+words[next()%words.length]+valid.slice(at+1));}
if(!accepted)throw Error('valid store never exercised');console.log('PASS',count);`,
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
    expect(child.stdout).toMatch(/^PASS 3002/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
