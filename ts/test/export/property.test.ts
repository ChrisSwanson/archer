import { test, expect } from "vitest";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compile } from "../../src/mermaid/index.ts";
test("export trust boundary refuses or emits valid SVG on a small stack against a clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archer-export-property-"));
  try {
    const bundle = await build({
      entryPoints: ["src/export/index.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      alias: { "@archer/export-painter": resolve("../ui/src/export/painter.ts") },
      banner: {
        js: 'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);',
      },
    });
    await writeFile(join(directory, "export.mjs"), bundle.outputFiles[0]!.contents);
    const model = (await compile("flowchart LR\n a[One]\n b[Two]\n a calls@--> b\n")).model;
    await writeFile(
      join(directory, "valid.json"),
      JSON.stringify({
        schemaVersion: 2,
        revision: `sha256:${"a".repeat(64)}`,
        view: { id: "test", kind: "freeform", title: "Test" },
        model,
      }),
    );
    await writeFile(
      join(directory, "property.mjs"),
      `
import {exportDiagram,ExportRefusal} from './export.mjs';
import {readFile} from 'node:fs/promises';
const valid=JSON.parse(await readFile(new URL('./valid.json',import.meta.url),'utf8'));
const resources={fontLicense:"SIL OPEN FONT LICENSE",themeCss:await readFile(${JSON.stringify(resolve("../ui/src/styles.css"))},'utf8'),fontFaces:[{weight:400,style:"normal",bytes:await readFile(${JSON.stringify(resolve("../ui/src/theme/fonts/fira-sans-latin-400.woff2"))})}],wasmBytes:new Uint8Array()};
let seed=7341;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const vocabulary=['schemaVersion','view','kind','revision','model','nodes','edges','label','type','freeform-graph','sequence-trace','state-machine','entity-relationship','c4-model','service-architecture','user-journey'];
function arbitrary(depth){const pick=rand()%8;if(depth>6||pick<4)return [null,rand(),String.fromCharCode(rand()%65536),!!(rand()%2)][pick%4];if(pick===4)return Array.from({length:rand()%4},()=>arbitrary(depth+1));const result={};for(let i=0;i<rand()%5;i++)result[vocabulary[rand()%vocabulary.length]]=arbitrary(depth+1);return result;}
let accepted=0,refused=0;
for(let i=0;i<350;i++){let input;if(i<150)input=arbitrary(0);else if(i<250){input={};for(const key of vocabulary)if(rand()%3===0)input[key]=vocabulary[rand()%vocabulary.length];}else {input=structuredClone(valid);if(i%5===0)input.model.nodes[0].label+='<&"';else if(i%5===1)input.model.nodes[0].label+='\\u0000';else if(i%5===2)input.revision='bad';else if(i%5===3)input.model.nodes[0].id='missing';else input.model.nodes[0].label+=' edit';}
try{const result=await exportDiagram(input,{resources});const svg=new TextDecoder().decode(result.bytes);if(result.mimeType!=='image/svg+xml'||!svg.startsWith('<svg ')||!svg.endsWith('</svg>')||!Number.isFinite(result.width)||result.width<=0)throw new Error('Invalid success outcome');accepted++;}catch(error){if(!(error instanceof ExportRefusal))throw error;refused++;}}
console.log(JSON.stringify({accepted,refused}));
`,
    );
    const result = spawnSync(process.execPath, ["--stack_size=128", join(directory, "property.mjs")], {
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const outcomes = JSON.parse(result.stdout.trim()) as {
      accepted: number;
      refused: number;
    };
    expect(outcomes.accepted).toBeGreaterThan(0);
    expect(outcomes.refused).toBeGreaterThan(250);
    expect(outcomes.accepted + outcomes.refused).toBe(350);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
