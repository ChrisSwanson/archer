/** New disk input trust boundary: actual parser in a small-stack child against a hard clock. */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { cleanUp, tempDir } from "../service/support.ts";
afterEach(cleanUp);
test("arbitrary, vocabulary and edited valid recovery inputs refuse or validate without panicking", async () => {
  const dir = tempDir(),
    module = join(dir, "parser.mjs"),
    runner = join(dir, "runner.mjs");
  await build({
    entryPoints: [new URL("../../src/state/account.ts", import.meta.url).pathname],
    outfile: module,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  writeFileSync(
    runner,
    `import {parseRecovery,parseAccountIndex,PersistenceError} from './parser.mjs';
const valid=JSON.stringify({version:1,root:'/project',presentation:null,selection:null,captions:[],lastChange:[],emphases:[],views:[]});const validIndex=JSON.stringify({version:1,projects:[{root:'/project',attached:true}]});let seed=12345;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};const vocab=['version','root','presentation','selection','captions','lastChange','emphases','views','blob','sha256:','projects','attached','true','false','[',']','{','}',':',',','null'];let refused=0,accepted=0;
function run(text){try{parseRecovery(text);accepted++}catch(e){if(!(e instanceof PersistenceError))throw e;refused++}}
run(valid);parseAccountIndex(validIndex);for(let i=0;i<Number(process.env.PROPTEST_CASES??3000);i++){const n=next()%200;let arbitrary='',words='';for(let j=0;j<n;j++){arbitrary+=String.fromCharCode(next()%128);words+=vocab[next()%vocab.length]}run(arbitrary);run(words);for(const text of [arbitrary,words,valid]){try{parseAccountIndex(text)}catch(e){if(!(e instanceof PersistenceError))throw e;}}const p=next()%valid.length;run(valid.slice(0,p)+String.fromCharCode(next()%128)+valid.slice(p+1));const q=next()%validIndex.length;try{parseAccountIndex(validIndex.slice(0,q)+String.fromCharCode(next()%128)+validIndex.slice(q+1));}catch(e){if(!(e instanceof PersistenceError))throw e;}}run('{"version":1,"root":"/p","presentation":null,"selection":null,"captions":[],"lastChange":[],"emphases":[],"views":[],"extra":'+ '['.repeat(64)+'0'+']'.repeat(64)+'}');run('{"version":1,"root":"/p","presentation":null,"selection":null,"captions":[],"lastChange":[],"emphases":[],"views":[],"extra":'+ '['.repeat(2000)+'0'+']'.repeat(2000)+'}');if(accepted<1||refused<1)throw new Error('corpus did not exercise both outcomes');console.log(JSON.stringify({accepted,refused}));`,
  );
  const result = spawnSync(process.execPath, ["--stack_size=256", runner], { encoding: "utf8", timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ refused: expect.any(Number), accepted: expect.any(Number) });
});
