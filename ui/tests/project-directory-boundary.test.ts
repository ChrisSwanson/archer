// @vitest-environment node
import { test, expect } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("catalog boundary refuses or returns valid bounded metadata on a small stack against a clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-catalog-boundary-"));
  try {
    const module = join(dir, "catalog.cjs");
    buildSync({
      entryPoints: [resolve(import.meta.dirname, "../src/app/project-directory.ts")],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    const script = join(dir, "property.cjs");
    writeFileSync(
      script,
      `const assert=require('node:assert/strict');
const {parseProjectCatalog}=require(${JSON.stringify(module)});
let seed=0x536c75;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const values=[null,true,false,0,1,'',[],{},'schemaVersion','projects','slug','name','views','notes','id','title','kind','durable','path','viewIds'];
const valid={schemaVersion:1,projects:[{slug:'courierdesk-12345678',name:'Courierdesk',views:[{id:'checkout',title:'Checkout',kind:'freeform',registration:'durable',sourcePath:'system/checkout.mmd'}],notes:[{path:'notes/operations.md',title:'Operations',viewIds:['checkout']}]}]};
const check=input=>{const result=parseProjectCatalog(input);assert(result===null||Array.isArray(result));if(result!==null){assert(result.length<=64);assert(new Set(result.map(p=>p.slug)).size===result.length);for(const p of result){assert(typeof p.slug==='string'&&typeof p.name==='string'&&p.name.trim());assert(Array.isArray(p.views)&&Array.isArray(p.notes)&&p.views.length+p.notes.length<=50000);}}};
for(let i=0;i<20000;i++){
 check(values[random()%values.length]);
 const arbitrary={};for(let j=0;j<8;j++)arbitrary[values[4+random()%(values.length-4)]]=values[random()%values.length];check(arbitrary);
 const edited=JSON.parse(JSON.stringify(valid));const fields=['slug','name','views','notes'];if(i%3===0)edited.schemaVersion=values[random()%values.length];else edited.projects[0][fields[random()%fields.length]]=values[random()%values.length];check(edited);
}
check(valid);const deep={schemaVersion:1,projects:[{...valid.projects[0],views:Array(50001).fill(valid.projects[0].views[0])}]};assert.deepEqual(parseProjectCatalog(deep),[]);const mixed={schemaVersion:1,projects:[deep.projects[0],{...valid.projects[0],slug:'sibling'}]};assert.deepEqual(parseProjectCatalog(mixed).map(p=>p.slug),['sibling']);process.stdout.write('60002 boundary cases passed');`,
    );
    const output = execFileSync(process.execPath, ["--stack-size=192", script], { encoding: "utf8", timeout: 10_000 });
    expect(output).toContain("60002 boundary cases passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
