import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { cumulativeDiff, CumulativeDiffError } from "../../src/changes/cumulative-diff.ts";

test("bounded cumulative diffs refuse or remain valid on a small stack; generated patches apply with real Git", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "archer-cumulative-diff-property-")),
    output = join(temporary, "property.cjs");
  try {
    await build({
      stdin: {
        contents: `
import {cumulativeDiff,CumulativeDiffError,CUMULATIVE_DIFF_LIMITS} from ${JSON.stringify(resolve("src/changes/cumulative-diff.ts"))};
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
let seed=0xc1a55eed;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0,pick=items=>items[next()%items.length];
const counts={arbitrary:[0,0],vocabulary:[0,0],edited:[0,0],git:0};
function check(before,after,path,category){
 let result;try{result=cumulativeDiff(before,after,path);}catch(error){if(!(error instanceof CumulativeDiffError))throw error;counts[category][1]++;return;}
 counts[category][0]++;
 if(typeof path!=='string'||Buffer.from(path).toString('utf8')!==path)throw new Error('accepted non-UTF8 path');
 if(!result||typeof result.text!=='string'||typeof result.complete!=='boolean'||!Number.isSafeInteger(result.bytes)||result.bytes<0||!['myers','whole-file-replacement'].includes(result.algorithm)||!Number.isSafeInteger(result.added)||result.added<0||!Number.isSafeInteger(result.removed)||result.removed<0||!['changed','none'].includes(result.netEffect))throw new Error('invalid accepted result shape');
 if(result.complete?(Buffer.byteLength(result.text)!==result.bytes||result.bytes>CUMULATIVE_DIFF_LIMITS.outputBytes):(result.text!==''||result.bytes<=CUMULATIVE_DIFF_LIMITS.outputBytes))throw new Error('incomplete output must be wholly omitted, never a truncated patch');
 if(before===after&&(result.text!==''||result.netEffect!=='none'||result.added||result.removed))throw new Error('no-effect identity was lost');
 if(before!==after&&result.netEffect!=='changed')throw new Error('changed bytes were mislabelled');
 return result;
}
const scalar=[null,undefined,false,true,0,1,{},[],()=>0,Symbol('untrusted'),'','flowchart LR\\n','\\uD800','\\uDC00','🐦','\\uFEFFa\\r\\nb'];
const words=['flowchart LR','%% comment','a[A]','b[🐦]','a e@--> b','subgraph grp','end','classDef hot fill:red','---','+++','@@ -1,1 +1,1 @@','\\\\ No newline at end of file','\\r','\\n','\\r\\n',' ', '"'];
function randomText(){return Array.from({length:next()%65},()=>String.fromCharCode(next()&65535)).join('');}
function text(){return Array.from({length:next()%20},()=>pick(words)).join(pick(['','\\n','\\r\\n']));}
for(let n=0;n<400;n++){
 check(next()%2?pick(scalar):randomText(),next()%2?pick(scalar):randomText(),next()%3?pick(['diagram.mmd','','../bad','/bad','a\\nb',null,{},'notes/a flow.mmd']):randomText(),'arbitrary');
 check(next()%3===0?null:text(),text(),pick(['diagram.mmd','notes/a flow.mmd','./bad','bad\\\\path']),'vocabulary');
 const before=text(),at=next()%(before.length+1),candidate=before.slice(0,at)+pick(['x','🐦','\\n','\\r\\n','\\uD800'])+before.slice(at+next()%3);
 check(before,candidate,'diagram.mmd','edited');
}
for(const category of ['arbitrary','vocabulary','edited']){check('A\\n','B\\n','diagram.mmd',category);check('A\\n','A\\n','diagram.mmd',category);check(123,'B','diagram.mmd',category);if(!counts[category][0]||!counts[category][1])throw new Error('missing accepted/refused coverage');}
for(const [before,after]of [[null,'x'.repeat(262144)],[null,'x'.repeat(262145)],['\\n'.repeat(262144),'a\\n'.repeat(131072)]])check(before,after,'diagram.mmd','arbitrary');
const unicode=['alpha','βeta','🐦','"quoted"','%% comment','---','+++','@@','', 'tab\\ttext',' space '];
for(let n=0;n<74;n++){
 const ending=n%3===0?'\\r\\n':n%3===1?'\\n':'\\r',baseline=Array.from({length:1+next()%24},(_,i)=>pick(unicode)+' '+i+ending),changed=[...baseline];
 const edit=n%4,at=next()%(changed.length+1);
 if(edit===0)changed.splice(at,0,'insert 🧭'+ending);
 else if(edit===1)changed.splice(Math.min(at,changed.length-1),1);
 else if(edit===2)changed[Math.min(at,changed.length-1)]='replacement '+pick(unicode)+ending;
 else{changed.splice(at,0,'one'+ending,'two'+ending);if(changed.length>3)changed.splice(0,1);}
 let before=(n%7===0?'\\uFEFF':'')+baseline.join(''),after=(n%7===0?'\\uFEFF':'')+changed.join('');
 if(n%5===0)before=before.replace(/(?:\\r\\n|\\r|\\n)$/u,'');if(n%6===0)after=after.replace(/(?:\\r\\n|\\r|\\n)$/u,'');if(n%11===0)before=null;
 if(n===72){before=Array.from({length:400},(_,i)=>'old '+i+'\\n').join('');after=before.replaceAll('old','new');}
 if(n===73){before=null;after='';}
 const path=pick(['diagram.mmd','a flow.mmd','quote"name.mmd','🧭.mmd']),result=check(before,after,path,'edited');if(!result||!result.complete)throw new Error('bounded generated edit must produce a complete patch');if(n===72&&result.algorithm!=='whole-file-replacement')throw new Error('distance bound must select labelled fallback');
 const directory=mkdtempSync(join(tmpdir(),'archer-generated-patch-'));
 try{
  if(before!==null)writeFileSync(join(directory,path),Buffer.from(before));
  const applied=spawnSync('git',['apply','--allow-empty','--whitespace=nowarn','-'],{cwd:directory,input:result.text,encoding:'utf8',timeout:1500,maxBuffer:1024*1024});
  if(applied.error||applied.status!==0)throw new Error('generated patch failed at case '+n+': '+applied.stderr+'\\n'+JSON.stringify({before,after,patch:result.text}));
  const actual=readFileSync(join(directory,path));if(!actual.equals(Buffer.from(after)))throw new Error('Git-produced bytes differ at case '+n+': '+JSON.stringify({before,after,actual:actual.toString(),patch:result.text}));
  counts.git++;
 }finally{rmSync(directory,{recursive:true,force:true});}
}
process.stdout.write(JSON.stringify(counts));
`,
        resolveDir: process.cwd(),
        sourcefile: "cumulative-diff-property-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile: output,
      logLevel: "silent",
    });
    const counts = JSON.parse(
      execFileSync(process.execPath, ["--stack_size=128", output], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }),
    );
    for (const category of ["arbitrary", "vocabulary", "edited"]) {
      expect(counts[category][0]).toBeGreaterThan(0);
      expect(counts[category][1]).toBeGreaterThan(0);
    }
    expect(counts.git).toBe(74);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 15000);

test("malformed UTF-16 paths must be named refusals before changing filename identity", () => {
  for (const path of ["\uD800.mmd", "\uDC00.mmd"])
    expect(() => cumulativeDiff(null, "x", path)).toThrow(CumulativeDiffError);
});
