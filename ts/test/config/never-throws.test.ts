import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { build } from "esbuild";

const VOCABULARY = [
  "version = 1\n",
  "[service]\n",
  "[[services]]\n",
  "[[projects]]\n",
  'name = "one"\n',
  'host = "localhost"\n',
  "port = 4400\n",
  'admission = "any"\n',
  'public_url = "https://example.test/"\n',
  'open_browser = "auto"\n',
  "auto_start = true\n",
  "restore = false\n",
  'path = "/tmp/**"\n',
  'service = "one"\n',
  "read_only = true\n",
  "admit = true\n",
  "diagrams = true\n",
  "notes = false\n",
  "comments = true\n",
  "emphasis = false\n",
  "register = true\n",
  "manifest = false\n",
  "# comment\n",
];

const COMPLETE = `version = 1
[service]
name = "fallback"
host = "localhost"
port = 4400
admission = "listed"
public_url = "https://example.test/"
open_browser = "auto"
auto_start = true
restore = false
[[services]]
name = "one"
host = "127.0.0.1"
port = 4401
admission = "any"
public_url = "http://localhost/"
open_browser = "never"
auto_start = false
restore = true
[[projects]]
path = "/tmp/**"
service = "one"
read_only = true
admit = false
diagrams = true
notes = false
comments = true
emphasis = false
register = true
manifest = false
`;

test("global configuration parsing never throws outside its contract on arbitrary, vocabulary and edited valid input", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-config-property-"));
  const output = join(scratch, "config.cjs");
  try {
    await build({
      stdin: {
        contents: `
        import {parseGlobalConfig} from ${JSON.stringify(resolve("src/config/index.ts"))};
        import {ProjectError} from ${JSON.stringify(resolve("src/project/errors.ts"))};
        import {isAbsolute,normalize} from "node:path";
        let state=29; const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
        const vocabulary=${JSON.stringify(VOCABULARY)};
        const valid=${JSON.stringify(COMPLETE)};
        const boolean=(value)=>value===undefined||typeof value==="boolean";
        const service=(s,named=false)=>{if(typeof s!=="object"||s===null||Array.isArray(s))throw new Error("bad service");if(s.name!==undefined&&!/^[a-z0-9][a-z0-9-]{0,31}$/.test(s.name))throw new Error("bad name");if(named&&typeof s.name!=="string")throw new Error("missing name");if(s.host!==undefined&&typeof s.host!=="string")throw new Error("bad host");if(s.port!==undefined&&(!Number.isInteger(s.port)||s.port<1024||s.port>65535))throw new Error("bad port");if(s.admission!==undefined&&!['any','listed'].includes(s.admission))throw new Error("bad admission");if(s.openBrowser!==undefined&&!['auto','always','never'].includes(s.openBrowser))throw new Error("bad browser mode");if(!boolean(s.autoStart)||!boolean(s.restore))throw new Error("bad service boolean");if(s.publicUrl!==undefined){const u=new URL(s.publicUrl);if(!/^https?:$/.test(u.protocol)||u.pathname!=='/'||u.search||u.hash||!/:\\d+$/.test(s.publicUrl))throw new Error("bad public URL");}};
        const outcome=(c)=>{if(c.version!==1)throw new Error("bad version");if(c.service!==undefined)service(c.service);if(c.services!==undefined){if(!Array.isArray(c.services))throw new Error("bad services");for(const s of c.services)service(s,true);}if(c.projects!==undefined){if(!Array.isArray(c.projects))throw new Error("bad projects");for(const p of c.projects){if(typeof p!=="object"||p===null||typeof p.path!=="string"||!isAbsolute(p.path)||normalize(p.path)!==p.path)throw new Error("bad path");if(p.service!==undefined&&!/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.service))throw new Error("bad project service");for(const key of ['readOnly','admit','diagrams','notes','comments','emphasis','register','manifest'])if(!boolean(p[key]))throw new Error("bad project boolean");}}};
        const check=(text)=>{try{outcome(parseGlobalConfig(text));}catch(e){if(!(e instanceof ProjectError)||e.code!=="manifest_error")throw e;}};
        outcome(parseGlobalConfig(valid));
        for(let round=0;round<250;round++){
          check(Array.from({length:next()%500},()=>String.fromCharCode(next()%65536)).join(""));
          check(Array.from({length:next()%80},()=>vocabulary[next()%vocabulary.length]).join(""));
          const at=next()%valid.length;
          check(valid.slice(0,at)+vocabulary[next()%vocabulary.length]+valid.slice(at+(next()%4)));
        }
        console.log("configuration outcomes valid");
      `,
        resolveDir: process.cwd(),
        sourcefile: "config-property.ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });
    expect(
      execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10_000 }),
    ).toContain("outcomes valid");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
