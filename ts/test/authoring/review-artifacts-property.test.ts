import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { resolve, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTempDirs, tempDir } from "../project/support.ts";
afterEach(removeTempDirs);

test("untrusted derived-file contents are refused unchanged or replaced from authority on a small stack", async () => {
  const output = join(tempDir(), "artifact-property.cjs");
  await build({
    stdin: {
      contents: `
 import {AuthoringStore} from ${JSON.stringify(resolve("src/authoring/store.ts"))};
 import {materializeReview} from ${JSON.stringify(resolve("src/authoring/review-artifacts.ts"))};
 import {findProject} from ${JSON.stringify(resolve("src/project/project.ts"))};
 import {chmodSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
 import {tmpdir} from 'node:os';import {join} from 'node:path';
 const base=realpathSync(mkdtempSync(join(tmpdir(),'artifact-property-')));
 try{
  const root=join(base,'project'),stateDir=join(base,'state');mkdirSync(root);mkdirSync(stateDir);chmodSync(stateDir,0o700);mkdirSync(join(root,'.archer'));writeFileSync(join(root,'.archer/a.mmd'),'B');
  const store=new AuthoringStore({stateDir,serviceName:'main',assertOwner(){}}),revision='sha256:'+'c'.repeat(64);
  const request={operationId:'1'.repeat(32),payloadDigest:revision,op:'document.apply',projectRoot:root,authority:{grantId:'g',entitlementId:'e'},feedback:{changes:'on_save',delivery:'next_call',effectiveRevision:revision},target:{kind:'document',path:'.archer/a.mmd'},expected:{sourceRevision:revision},base:store.putSnapshot(Buffer.from('A')),candidate:store.putSnapshot(Buffer.from('B'))};
  store.beginOperation(request);store.completeSourceOperation(request.operationId,revision,{outcome:'applied',document:{path:'.archer/a.mmd',sourceRevision:revision,modelRevision:null},evidence:'observed',review:{mode:'on_save',configRevision:revision,state:'admission_pending'}});
  const project=findProject(root),review=store.listReviews(root)[0],first=materializeReview(project,store,review.reviewId);if(first.status!=='written')throw Error('setup artifact refused');
  const path=join(root,first.path),canonical=readFileSync(path);let seed=0xa71fac7;
  const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0,pick=xs=>xs[next()%xs.length];
  const counts={bytes:[0,0],vocabulary:[0,0],edited:[0,0]};
  function check(bytes,category){writeFileSync(path,bytes);const result=materializeReview(project,store,review.reviewId);const actual=readFileSync(path);if(result.status==='written'){if(!actual.equals(canonical))throw Error('written artifact differs from authority');counts[category][0]++;}else if(result.status==='blocked'){if(!actual.equals(bytes))throw Error('refused file changed');counts[category][1]++;}else throw Error('unexpected status '+result.status);if(store.readSnapshot(review.latest).toString()!=='B')throw Error('derived input changed source authority');}
  for(const category of Object.keys(counts)){check(canonical,category);check(Buffer.from('foreign'),category);}
  const words=['# archer-review v1','\\n','# identity ','store_','gen_','reviewId','subject','__proto__','{','[','null',']','}',':','"','../','\\r','\\0'];
  for(let n=0;n<80;n++){
   const bytes=Buffer.alloc(next()%1025);for(let i=0;i<bytes.length;i++)bytes[i]=next()&255;check(bytes,'bytes');
   check(Buffer.from(Array.from({length:next()%50},()=>pick(words)).join('')),'vocabulary');
   const at=next()%canonical.length,remove=next()%Math.min(9,canonical.length-at),insert=Buffer.from(pick([' ','x','\\n','# archer-review v1','',String(next())]));
   check(Buffer.concat([canonical.subarray(0,at),insert,canonical.subarray(at+remove)]),'edited');
  }
  check(Buffer.from('['.repeat(12000)+'0'+']'.repeat(12000)),'vocabulary');
  process.stdout.write(JSON.stringify(counts));
 }finally{rmSync(base,{recursive:true,force:true});}
 `,
      resolveDir: process.cwd(),
      loader: "ts",
      sourcefile: "artifact-property.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: output,
    target: "node22",
    logLevel: "silent",
  });
  const counts = JSON.parse(
    execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 15000 }),
  );
  for (const countsByOutcome of Object.values(counts) as number[][]) {
    expect(countsByOutcome[0]).toBeGreaterThan(0);
    expect(countsByOutcome[1]).toBeGreaterThan(0);
  }
}, 20000);
