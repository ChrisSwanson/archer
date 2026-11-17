import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("cursor and four IPC boundaries refuse or validate arbitrary, vocabulary and edited inputs on a small stack against a clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-change-review-boundary-"));
  try {
    const entry = join(directory, "probe.ts"),
      output = join(directory, "probe.cjs");
    writeFileSync(
      entry,
      `import {parseChangeCursor} from ${JSON.stringify(new URL("../../src/changes/review.ts", import.meta.url).pathname)};
import {ChangeStoreError} from ${JSON.stringify(new URL("../../src/changes/index.ts", import.meta.url).pathname)};
import {parseRequest,MethodError} from ${JSON.stringify(new URL("../../src/service/socket.ts", import.meta.url).pathname)};
let seed=53;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const identity={root:'/tmp/project',storeId:'store_'+'1'.repeat(32),generation:'gen_'+'2'.repeat(32)};
const valid=JSON.stringify({...identity,upper:12,after:3});const encode=text=>Buffer.from(text).toString('base64url');
const words=['root','storeId','generation','upper','after','cursor','limit','changeId','expectedReviewRevision','disposition','handled','before','after','null','[]','{}'];
const methods=['pendingChanges','listChanges','readChange','resolveChange'];
const good={pendingChanges:{root:identity.root,limit:3},listChanges:{root:identity.root,limit:20,cursor:encode(valid)},readChange:{root:identity.root,changeId:'chg_'+'3'.repeat(32),part:'before'},resolveChange:{root:identity.root,changeId:'chg_'+'3'.repeat(32),expectedReviewRevision:1,disposition:'handled'}};
let accepted=0,count=0;
const cursor=input=>{count++;try{const result=parseChangeCursor(input,identity);if(result.root!==identity.root||result.storeId!==identity.storeId||result.generation!==identity.generation||result.after>result.upper)throw Error('invalid accepted cursor');accepted++;}catch(e){if(!(e instanceof ChangeStoreError))throw e;}};
const request=(method,params)=>{count++;try{const result=parseRequest({id:1,method,params});if(result.method!==method||typeof result.params.root!=='string')throw Error('invalid accepted method');accepted++;}catch(e){if(!(e instanceof MethodError))throw e;}};
cursor(encode(valid));for(const method of methods)request(method,good[method]);cursor(encode('['.repeat(1000)+'0'+']'.repeat(1000)));
for(let i=0;i<1000;i++){const arbitrary=String.fromCharCode(next()%65536).repeat(next()%200),word=words[next()%words.length],at=next()%valid.length;cursor(arbitrary);cursor(encode(JSON.stringify({[word]:word})));cursor(encode(valid.slice(0,at)+word+valid.slice(at+1)));const method=methods[i%methods.length];request(method,arbitrary);request(method,{[word]:word});request(method,{...good[method],[word]:next()%2?arbitrary:next()});}
if(accepted<5)throw Error('valid paths never exercised');console.log('PASS',count);`,
    );
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    const child = spawnSync(process.execPath, ["--stack_size=128", output], { encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/^PASS 6006/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
