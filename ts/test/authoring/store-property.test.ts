import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
test("authoring-index parser refuses or returns stable valid records on a small stack and bounded clock", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "authoring-property-"))),
    output = join(root, "property.cjs");
  try {
    await build({
      stdin: {
        contents: `
  import {AuthoringStore,AuthoringStoreError,parseAuthoringIndex} from ${JSON.stringify(resolve("src/authoring/store.ts"))};
  import {chmodSync,mkdtempSync,realpathSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
  const root=realpathSync(mkdtempSync(join(tmpdir(),'authoring-property-state-')));chmodSync(root,0o700);
  let seed=0x51a7c0de;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;const pick=x=>x[next()%x.length];
  const counts={bytes:[0,0],json:[0,0],vocabulary:[0,0],edited:[0,0]};
  function check(bytes,category){let parsed;try{parsed=parseAuthoringIndex(bytes);}catch(e){if(!(e instanceof AuthoringStoreError))throw e;counts[category][1]++;return;}const again=parseAuthoringIndex(Buffer.from(JSON.stringify(parsed)));if(JSON.stringify(again)!==JSON.stringify(parsed))throw new Error('unstable accepted parser output');counts[category][0]++;}
  function json(depth=0){const leaves=[null,false,true,next(),'','🧭'];if(depth>7||next()%3===0)return pick(leaves);if(next()%2)return Array.from({length:next()%6},()=>json(depth+1));const value={};for(let n=0;n<next()%6;n++)value[pick(['drafts','operations','version','head','origin','completion','x'+n])]=json(depth+1);return value;}
  try{
    const s=new AuthoringStore({stateDir:root,serviceName:'main',assertOwner(){}});
    s.saveDraft({projectRoot:'/projects/property',draftId:'drf_'+'1'.repeat(32),expectedDraftRevision:null,origin:{kind:'new',proposedPath:'.archer/a.mmd'},source:Buffer.from('flowchart LR\\r\\n a[🧭]\\r\\n'),valid:true});
    const bytes=readFileSync(join(root,'runtime/authoring/index.json'));
    const ref=s.putSnapshot(Buffer.from('flowchart LR\\n a[A]'));
    const request={operationId:'2'.repeat(32),payloadDigest:'sha256:'+'3'.repeat(64),op:'document.apply',projectRoot:'/projects/property',authority:{grantId:'grant',entitlementId:'ent'},feedback:{changes:'on_save',delivery:'next_call',effectiveRevision:'sha256:'+'4'.repeat(64)},target:{kind:'document',path:'.archer/a.mmd'},expected:{sourceRevision:null},base:null,candidate:ref};
    s.beginOperation(request);s.completeSourceOperation(request.operationId,request.payloadDigest,{outcome:'applied',evidence:'observed',document:{path:'.archer/a.mmd',sourceRevision:ref.revision,modelRevision:null,normalized:{pinnedName:false,lineEndings:false}},review:{mode:'on_save',configRevision:request.feedback.effectiveRevision,state:'admission_pending'}});
    const persisted=readFileSync(join(root,'runtime/authoring/index.json'));
    const words=['{','}','[',']',':',',','"','drafts','operations','reviews','reviewId','reviewRevision','baseline','latest','externalGaps','held','cleared','origin','head','revisions','state','source','draftId','operationId','completion','review','intent','uncertain','terminal','sha256:','drf_','false','true','null','1','🧭'];
    for(const key of Object.keys(counts)){check(bytes,key);check(persisted,key);check(Buffer.from('null'),key);}
    for(let n=0;n<350;n++){
      const random=Buffer.alloc(next()%1025);for(let i=0;i<random.length;i++)random[i]=next()&255;check(random,'bytes');
      check(Buffer.from(JSON.stringify(json())),'json');
      check(Buffer.from(Array.from({length:next()%100},()=>pick(words)).join('')),'vocabulary');
      const at=next()%persisted.length,remove=next()%Math.min(9,persisted.length-at),insert=Buffer.from(pick([' ','"',':null','[]','',String(next())]));
      check(Buffer.concat([persisted.subarray(0,at),insert,persisted.subarray(at+remove)]),'edited');
    }
    const nested='['.repeat(12000)+'0'+']'.repeat(12000);check(Buffer.from(nested),'json');
    for(const [key,[accepted,refused]]of Object.entries(counts))if(!accepted||!refused)throw new Error('missing accepted/refused coverage: '+key);
    process.stdout.write(JSON.stringify(counts));
  } finally {rmSync(root,{recursive:true,force:true});}
  `,
        resolveDir: process.cwd(),
        sourcefile: "authoring-property-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      target: "node22",
      logLevel: "silent",
    });
    const counts = JSON.parse(
      execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10000 }),
    );
    for (const value of Object.values(counts) as number[][]) {
      expect(value[0]).toBeGreaterThan(0);
      expect(value[1]).toBeGreaterThan(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
