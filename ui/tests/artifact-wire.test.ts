import { build } from "esbuild";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";

test("artifact and staleness wires refuse or validate arbitrary, vocabulary and mutated inputs on a small stack", async () => {
  const result = await build({
    stdin: {
      contents:
        'export {readArtifact} from "./src/export/download.ts"; export {readStaleView} from "./src/accuracy/Staleness.tsx";',
      resolveDir: new URL("..", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    loader: { ".css": "empty" },
  });
  const outcome = await new Promise((resolve, reject) => {
    const worker = new Worker(
      `
            const {parentPort}=require('node:worker_threads');
            const exports={};const module={exports};
            (function(exports,module){${result.outputFiles[0]!.text}})(exports,module);
            const {readArtifact,readStaleView}=module.exports;
            const words=[null,false,0,[],{},"available","stale","modified","base64","image/svg+xml"];
            const artifact={encoding:"base64",mimeType:"image/svg+xml",width:100,height:100,revision:"rev",lastGood:false,data:btoa("<svg/>")};
            const stale={status:"available",views:[{viewId:"flow",status:"stale",baselineCommit:null,covers:[],changedPaths:[]}]};
            let state=712;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
            const count=Number(process.env.PROPTEST_CASES||1000);
            for(let corpus=0;corpus<3;corpus++)for(let i=0;i<count;i++)for(const kind of [0,1]){
                let input;
                if(corpus===0)input=Array.from({length:Math.floor(next()*10)},()=>String.fromCharCode(Math.floor(next()*65536)));
                else if(corpus===1)input={status:words[Math.floor(next()*words.length)],views:words[Math.floor(next()*words.length)],data:words[Math.floor(next()*words.length)]};
                else {input=JSON.parse(JSON.stringify(kind?stale:artifact));const keys=Object.keys(input);input[keys[Math.floor(next()*keys.length)]]=words[Math.floor(next()*words.length)];}
                try {const accepted=kind?readStaleView(input,"flow"):readArtifact(input,"svg","rev");if(kind&&!['current','stale','not-covered','never-reviewed','unavailable'].includes(accepted.status))throw new TypeError('invalid accepted status');if(!kind&&accepted.revision!=="rev")throw new TypeError('invalid accepted revision');}
                catch(error){if(error.constructor!==Error)throw error;}
            }
            parentPort.postMessage({cases:count*6,corpora:3});
        `,
      { eval: true, resourceLimits: { stackSizeMb: 1 }, execArgv: [] },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("artifact wire property clock exceeded"));
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
  });
  expect(outcome).toEqual({ cases: Number(process.env.PROPTEST_CASES || 1000) * 6, corpora: 3 });
}, 20000);
