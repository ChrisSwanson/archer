import { expect, test } from "vitest";
import { parsePresentationRequest, parsePresentationPositions } from "../../../shared/authoring-presentation.mts";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("strict bounded positions and requests refuse extras, accessors, prototypes and unsafe values", () => {
  expect(parsePresentationPositions({ constructor: { x: 1, y: 2 }, prototype: { x: 3, y: 4 } })).toEqual({
    constructor: { x: 1, y: 2 },
    prototype: { x: 3, y: 4 },
  });
  const positions = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => ["n" + i, { x: 1e7, y: -1e7 }]));
  expect(Object.keys(parsePresentationPositions(positions))).toHaveLength(2048);
  for (const value of [
    { ...positions, excess: { x: 0, y: 0 } },
    { a: { x: NaN, y: 0 } },
    { a: { x: 1e7 + 1, y: 0 } },
    { a: { x: 0, y: 0, z: 0 } },
    Object.create({ a: { x: 1, y: 2 } }),
    Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        throw new Error("invoked");
      },
    }),
  ])
    expect(() => parsePresentationPositions(value)).toThrow(/invalid presentation/);
  expect(() =>
    parsePresentationRequest({
      op: "read",
      target: { kind: "view", viewId: "v" },
      expectedTargetRevision: "sha256:" + "a".repeat(64),
      positions: {},
    }),
  ).toThrow();
});
test("presentation index/request parsers refuse or return stable records on small stack and clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "presentation-property-")),
    output = join(dir, "property.cjs");
  try {
    await build({
      stdin: {
        contents: `
 import {parsePresentationIndex,PresentationStoreError} from ${JSON.stringify(resolve("src/authoring/presentation-store.ts"))};
 import {parsePresentationRequest,PresentationInputError} from ${JSON.stringify(resolve("../shared/authoring-presentation.mts"))};
 let seed=91234;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;let accepted=0,refused=0,indexAccepted=0,indexRefused=0;
 const seedIndex=Buffer.from(JSON.stringify({version:1,serviceName:'test',entries:[]}));
 function checkIndex(bytes){try{const parsed=parsePresentationIndex(bytes);if(JSON.stringify(parsePresentationIndex(Buffer.from(JSON.stringify(parsed))))!==JSON.stringify(parsed))throw Error('unstable index');indexAccepted++;}catch(e){if(!(e instanceof PresentationStoreError))throw e;indexRefused++;}}
 const good={op:'save',target:{kind:'view',viewId:'flow'},expectedTargetRevision:'sha256:'+'a'.repeat(64),sourceRevision:'sha256:'+'b'.repeat(64),expectedRevision:null,positions:{a:{x:2,y:3}}};
 function check(value){try{const parsed=parsePresentationRequest(value);if(JSON.stringify(parsePresentationRequest(parsed))!==JSON.stringify(parsed))throw Error('unstable');accepted++;}catch(e){if(!(e instanceof PresentationInputError))throw e;refused++;}}
 for(let i=0;i<400;i++){check(good);check({...good,positions:{a:{x:next()%2?NaN:next(),y:next()}}});const bytes=Buffer.alloc(next()%1024);for(let j=0;j<bytes.length;j++)bytes[j]=next()%256;checkIndex(bytes);checkIndex(seedIndex);const at=next()%seedIndex.length;checkIndex(Buffer.concat([seedIndex.subarray(0,at),Buffer.from(['null','[]','entries','version','positions','0',':'][next()%7]),seedIndex.subarray(at+1)]));check(JSON.parse(JSON.stringify(good).replace('save',i%2?'read':'unknown')));}
 try{parsePresentationIndex(Buffer.from('['.repeat(12000)+'0'+']'.repeat(12000)));}catch(e){if(!(e instanceof PresentationStoreError))throw e;}
 process.stdout.write(JSON.stringify({accepted,refused,indexAccepted,indexRefused}));`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });
    const counts = JSON.parse(
      execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10000 }),
    );
    expect(counts.accepted).toBeGreaterThan(0);
    expect(counts.refused).toBeGreaterThan(0);
    expect(counts.indexAccepted).toBeGreaterThan(0);
    expect(counts.indexRefused).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
