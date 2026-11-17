import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, test } from "vitest";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

test("lifecycle disk and HTTP parsers accept or refuse arbitrary, vocabulary, and edited valid input on a small stack", async () => {
  const directory = tempDir("archer-lifecycle-property-");
  const stateModule = join(directory, "state.mjs");
  const requestModule = join(directory, "request.mjs");
  const runner = join(directory, "runner.mjs");
  await build({
    entryPoints: [new URL("../../src/state/project-lifecycle.ts", import.meta.url).pathname],
    outfile: stateModule,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  await build({
    entryPoints: [new URL("../../src/service/project-lifecycle.ts", import.meta.url).pathname],
    outfile: requestModule,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  writeFileSync(
    runner,
    `
import {parseProjectLifecycle} from './state.mjs';
import {parseProjectLifecycleMutation,ProjectLifecycleRequestError} from './request.mjs';
const validState=JSON.stringify({version:1,projects:[{root:'/project',firstObservedAt:'2026-10-15T12:00:00.000Z',emptySince:'2026-10-15T12:00:00.000Z',everHadContent:false,automaticEligible:true,visibility:'auto'}]});
const validRequest={slug:'project-12345678',action:'archive'};
const words=['version','projects','root','firstObservedAt','emptySince','everHadContent','automaticEligible','visibility','auto','visible','hidden','slug','action','show','archive','true','false','null','[',']','{','}',':',',',''];
let seed=90210,accepted=0,refused=0;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
const value=(depth=0)=>{if(depth>4||next()%3===0)return [null,true,false,next(),words[next()%words.length]][next()%5];if(next()%2===0)return Array.from({length:next()%5},()=>value(depth+1));const out={};for(let n=next()%6;n>0;n--)out[words[next()%words.length]]=value(depth+1);return out};
const state=text=>{try{parseProjectLifecycle(text);accepted++}catch(error){if(error?.name!=='PersistenceError')throw error;refused++}};
const request=input=>{try{parseProjectLifecycleMutation(input);accepted++}catch(error){if(!(error instanceof ProjectLifecycleRequestError))throw error;refused++}};
state(validState);request(validRequest);
for(let i=0;i<2000;i++){
  let arbitrary='',vocabulary='';for(let n=next()%160;n>0;n--){arbitrary+=String.fromCharCode(next()%128);vocabulary+=words[next()%words.length]}
  state(arbitrary);state(vocabulary);request(value());
  const at=next()%validState.length;state(validState.slice(0,at)+String.fromCharCode(next()%128)+validState.slice(at+1));
  const edited={...validRequest,[words[next()%words.length]]:value()};request(edited);
}
state('{"version":1,"projects":[],"extra":'+ '['.repeat(2000)+'0'+']'.repeat(2000)+'}');
if(accepted<2||refused<2)throw new Error('corpus missed an outcome');
console.log(JSON.stringify({accepted,refused}));
`,
  );
  const result = spawnSync(process.execPath, ["--stack_size=256", runner], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ accepted: expect.any(Number), refused: expect.any(Number) });
});
