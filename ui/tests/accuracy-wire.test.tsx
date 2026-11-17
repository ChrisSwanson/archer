import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
test("comparison wire is refused or renderable for arbitrary, vocabulary and mutated-valid inputs on a small stack against a clock", async () => {
  const moduleUrl = new URL("../src/accuracy/wire.ts", import.meta.url).href;
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(
      `
   const {parentPort}=require('node:worker_threads');
   import('tsx/esm/api').then(async({tsImport})=>{
    const {readComparison}=await tsImport(${JSON.stringify(moduleUrl)},${JSON.stringify(import.meta.url)});
    let state=478;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const words=[null,false,0,"compiled","failed","unavailable","changed","moved",[],{},"git_unavailable"];
    const base={before:{status:"compiled",commit:"a".repeat(40),path:".archer/a.mmd",result:{diagnostics:[]}},after:{status:"unavailable",reason:"historical_registry_missing"},sourceChanged:null,semantic:null};
    for(let corpus=0;corpus<3;corpus++)for(let i=0;i<1000;i++){
     let value;
     if(corpus===0)value=Array.from({length:Math.floor(next()*10)},()=>String.fromCharCode(Math.floor(next()*65536)));
     else if(corpus===1)value={before:words[Math.floor(next()*words.length)],after:words[Math.floor(next()*words.length)],sourceChanged:words[Math.floor(next()*words.length)],semantic:words[Math.floor(next()*words.length)]};
     else {value=JSON.parse(JSON.stringify(base));const where=next()<.5?'before':'after';value[where][['status','commit','path','reason','result'][Math.floor(next()*5)]]=words[Math.floor(next()*words.length)];}
     try {const accepted=readComparison(value);if(!['compiled','failed','unavailable'].includes(accepted.before.status)||!(accepted.sourceChanged===null||typeof accepted.sourceChanged==='boolean'))throw new TypeError('invalid accepted wire');}
     catch(error){if(error.constructor!==Error)throw error;}
    }
    parentPort.postMessage({cases:3000,corpora:3});
   }).catch(error=>{throw error;});
  `,
      { eval: true, resourceLimits: { stackSizeMb: 1 }, execArgv: [] },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("comparison wire property clock exceeded"));
    }, 15000);
    worker.once("message", (value) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("comparison wire worker exited " + code));
    });
  });
  expect(result).toEqual({ cases: 3000, corpora: 3 });
}, 20000);
