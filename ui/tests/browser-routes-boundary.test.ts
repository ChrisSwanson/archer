// @vitest-environment node
import { expect, it } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
it("arbitrary, vocabulary-built and slightly edited routes refuse or round-trip on a small stack", () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-routes-boundary-"));
  try {
    const module = join(directory, "routes.cjs");
    buildSync({
      entryPoints: [resolve(import.meta.dirname, "../../shared/browser-routes.mts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: module,
      logLevel: "silent",
    });
    const script = join(directory, "boundary.cjs");
    writeFileSync(
      script,
      `const assert=require('node:assert/strict');const {readBrowserRoute,browserRoutePath}=require(${JSON.stringify(module)});
let seed=5281;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const vocabulary=['p','projects','browse','documents','notes','views','-','repo','archer','archer-12345678','%2F','%5C','%00','..','%2e%2e','%ZZ','a.md','notes%2Fa.md%23login','架構','#login','?follow',''];
const valid=['/projects/','/projects/archer/?follow','/projects/archer/notes/','/projects/archer/notes/a.md#login','/projects/archer/-/repo/docs/a.md','/p/archer-12345678/browse/notes/','/p/archer-12345678/documents/docs/a.md','/p/archer-12345678/views/notes%2Fa.md%23login/'];
// Legacy forms build to their canonical replacement; every built address is a fixpoint.
const split=href=>{const url=new URL(href,'https://host');const path=href.split(/[?#]/)[0];return [path,url.search,url.hash];};
const check=href=>{const [path,search,hash]=href.startsWith('/')?split(href):[href,'',''];const result=readBrowserRoute(path,search,hash);if(result!==null){const serialized=browserRoutePath(result);if(serialized===null){assert.ok(['file','note','browse'].includes(result.kind)&&(result.path??result.folder).split('/')[0]==='-');return;}const again=readBrowserRoute(...split(serialized));assert.notEqual(again,null);assert.equal(browserRoutePath(again),serialized);}};
for(let i=0;i<20000;i++){let arbitrary='';for(let j=0;j<24;j++)arbitrary+=String.fromCharCode(random()%65536);check(arbitrary);check('/'+Array.from({length:1+random()%8},()=>vocabulary[random()%vocabulary.length]).join('/'));const original=valid[random()%valid.length];const index=random()%original.length;check(original.slice(0,index)+vocabulary[random()%vocabulary.length]+original.slice(index+1));}
check('/p/a/browse/'+('x/'.repeat(10000)));check('/projects/a/'+('x/'.repeat(10000)));process.stdout.write('60001 boundary cases passed');`,
    );
    expect(
      execFileSync(process.execPath, ["--stack-size=192", script], { encoding: "utf8", timeout: 10000 }),
    ).toContain("60001 boundary cases passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
