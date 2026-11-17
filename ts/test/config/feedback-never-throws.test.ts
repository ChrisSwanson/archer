import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("feedback TOML boundaries refuse or produce valid settings for arbitrary, vocabulary and edited inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "archer-feedback-property-"));
  const output = join(root, "property.cjs");
  try {
    await build({
      stdin: {
        contents: `
      import {parseGlobalConfig} from ${JSON.stringify(resolve("src/config/index.ts"))};
      import {historicalRegistry} from ${JSON.stringify(resolve("src/project/project.ts"))};
      import {ProjectError} from ${JSON.stringify(resolve("src/project/errors.ts"))};
      import {TomlError} from ${JSON.stringify(resolve("src/project/toml.ts"))};
      let state=71;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
      const words=['version = 1\\n','[feedback]\\n','changes','delivery','allow_notifications',' = ','"on_save"','"manual"','"next_call"','"next_call_and_notify"','true','false','{','}','[',']','\\n','#','"','🧭'];
      const seeds=['version = 1\\n[feedback]\\nchanges = "manual"\\ndelivery = "next_call_and_notify"\\n','version = 1\\n[feedback]\\nallow_notifications = false\\n'];
      let accepted=0,refused=0;
      function check(text,project){
        let result;
        try {result=project?historicalRegistry(text,'/tmp/archer-property-project'):parseGlobalConfig(text);}
        catch(error){if(!(error instanceof ProjectError)&&!(error instanceof TomlError))throw error;refused++;return;}
        const f=result.feedback;
        if(f){
          if(Object.keys(f).some(k=>!['changes','delivery','allowNotifications'].includes(k)))throw new Error('unknown parsed key');
          if(f.changes!==undefined&&!['on_save','manual'].includes(f.changes))throw new Error('bad changes');
          if(f.delivery!==undefined&&!['next_call','next_call_and_notify'].includes(f.delivery))throw new Error('bad delivery');
          if(f.allowNotifications!==undefined&&(project||typeof f.allowNotifications!=='boolean'))throw new Error('bad global gate');
        }
        accepted++;
      }
      for(const text of seeds){check(text,false);check(text,true);}
      for(let i=0;i<400;i++){
        const arbitrary=Array.from({length:next()%200},()=>String.fromCharCode(next()%65536)).join('');
        const vocabulary=Array.from({length:next()%36},()=>words[next()%words.length]).join('');
        const valid=seeds[i%seeds.length],at=next()%valid.length;
        const edited=valid.slice(0,at)+words[next()%words.length]+valid.slice(at+next()%3);
        for(const text of [arbitrary,vocabulary,edited]){check(text,false);check(text,true);}
      }
      if(accepted===0||refused===0)throw new Error('outcome coverage missing');
      console.log('feedback outcomes refused or valid: '+(accepted+refused));
    `,
        resolveDir: process.cwd(),
        sourcefile: "feedback-property.ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });
    expect(
      execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10000 }),
    ).toContain("feedback outcomes refused or valid: 2404");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
