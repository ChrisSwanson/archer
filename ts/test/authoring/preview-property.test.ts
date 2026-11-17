import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { expect, test } from "vitest";
test("preview parser is refused or valid on bounded adversarial vocabulary and a small stack", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-preview-boundary-"));
  try {
    const entry = join(scratch, "probe.ts"),
      output = join(scratch, "probe.mjs");
    writeFileSync(
      entry,
      `import {parseAuthoringPreview} from ${JSON.stringify(new URL("../../src/authoring/preview-input.ts", import.meta.url).pathname)};
import {AuthoringInputError} from ${JSON.stringify(new URL("../../../shared/authoring-contract.mts", import.meta.url).pathname)};
let seed=451;const rand=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const vocab=[null,undefined,true,0,[],{},'source','kind','connect','direction','rectangle','a','tb','diamond','line','dotted','thick','',String.fromCharCode(0),String.fromCharCode(10),'x'.repeat(8193)];
const valid=[{kind:'add-node',id:'c',label:'',shape:'diamond'},{kind:'relabel-node',id:'a',label:'A'},{kind:'connect',id:'e1',source:'a',target:'b',line:'thick'},{kind:'direction',direction:'tb'},{kind:'change-shape',id:'a',shape:'rectangle'}];
let count=0,accepted=0;
const check=(value,editing)=>{count++;try{const result=parseAuthoringPreview(value,editing);if(typeof result.source!=='string'||(editing&&!result.edit))throw Error('invalid accepted');accepted++;}catch(e){if(!(e instanceof AuthoringInputError))throw e;}};
for(let n=0;n<1500;n++){const a=vocab[rand()%vocab.length],b=vocab[rand()%vocab.length];check(a,false);check({source:a,edit:b},true);const edit={...valid[n%valid.length]};edit[Object.keys(edit)[n%Object.keys(edit).length]]=b;check({source:'flowchart LR\\n a[A]\\n',edit},true);check({source:'x',edit:valid[n%valid.length]},true);}
let deep={};for(let n=0;n<6000;n++)deep={next:deep};check({source:deep},false);const cycle={};cycle.next=cycle;check({source:'x',edit:cycle},true);
const getter={};Object.defineProperty(getter,'source',{get(){throw Error('getter executed')}});check(getter,false);check(new Proxy({},{ownKeys(){throw Error('proxy invoked')}}),true);
if(!accepted)throw Error('no accepted');console.log('PASS',count,accepted);`,
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
    expect(child.stdout).toMatch(/^PASS 6004 /);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
