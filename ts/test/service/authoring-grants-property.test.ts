import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("entitlement and new-management parsers refuse or validate bounded arbitrary, vocabulary and edited inputs on a small stack", async () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-authoring-boundary-"));
  try {
    const entry = join(directory, "probe.ts"),
      output = join(directory, "probe.mjs");
    writeFileSync(
      entry,
      `import {parseAuthoringGrants,AuthoringGrantError} from ${JSON.stringify(new URL("../../src/service/authoring-grants.ts", import.meta.url).pathname)};
import {parseRequest,MethodError} from ${JSON.stringify(new URL("../../src/service/socket.ts", import.meta.url).pathname)};
let seed=31;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const words=['version','entitlements','entitlementId','grantId','projectRoots','issuedAt','revokedAt','label','null','[]','{}','/tmp/project'];
const valid=JSON.stringify({version:1,entitlements:[{entitlementId:'a1234567-1234-4234-8234-123456789abc',grantId:'b1234567-1234-4234-8234-123456789abc',projectRoots:['/tmp/project'],issuedAt:'2026-10-18T00:00:00.000Z',revokedAt:null}]});
const validParams={label:'Editor',projectRoots:['/tmp/project']};
let accepted=0,count=0;
const check=(text)=>{count++;try{const result=parseAuthoringGrants(text);if(result.version!==1||!Array.isArray(result.entitlements)||result.entitlements.length>1024)throw Error('invalid accepted store');accepted++;}catch(e){if(!(e instanceof AuthoringGrantError))throw e;}};
const request=(params)=>{count++;try{const result=parseRequest({id:1,method:'issueAuthoringAccess',params});if(result.method!=='issueAuthoringAccess'||typeof result.params.label!=='string'||!Array.isArray(result.params.projectRoots)||result.params.projectRoots.length<1||result.params.projectRoots.length>16)throw Error('invalid accepted request');accepted++;}catch(e){if(!(e instanceof MethodError))throw e;}};
check(valid);request(validParams);check('['.repeat(30000)+'0'+']'.repeat(30000));
for(let i=0;i<1000;i++){const arbitrary=String.fromCharCode(next()%65536).repeat(next()%200);const word=words[next()%words.length];check(arbitrary);check(JSON.stringify({[word]:words[next()%words.length]}));const at=next()%valid.length;check(valid.slice(0,at)+word+valid.slice(at+1));request(arbitrary);request({[word]:word});request({...validParams,projectRoots:i%2?[arbitrary]:[word],...(i%3===0?{[word]:arbitrary}:{})});}
if(accepted<2)throw Error('valid paths never exercised');console.log('PASS',count);`,
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
    expect(child.stdout).toMatch(/^PASS 6003/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
