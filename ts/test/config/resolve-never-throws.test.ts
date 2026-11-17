import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("service resolution and glob matching stay bounded and never throw outside their contract", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-resolve-property-"));
  const output = join(scratch, "resolve.cjs");
  try {
    await build({
      stdin: {
        contents: `
        import {resolveServiceConfiguration,projectPatternMatches,selectProjectRule} from ${JSON.stringify(resolve("src/config/resolve.ts"))};
        import {ProjectError} from ${JSON.stringify(resolve("src/project/errors.ts"))};
        let state=41;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
        const vocabulary=['*','**','/','a','-','.',String.fromCharCode(0),'service','default','4400','true','false','always'];
        const valid={projectRoot:'/work/project',projectServiceName:'manifest',system:{version:1,service:{name:'system'},services:[{name:'chosen',host:'localhost',port:4400}],projects:[{path:'/work/**',service:'chosen'}]},user:{version:1,projects:[{path:'/work/project',service:'chosen'}]},env:{HOME:'/home/me',ARCHER_OPEN_BROWSER:'auto',ARCHER_AUTO_START:'true',ARCHER_RESTORE_STATE:'false'}};
        const outcome=(r)=>{if(!/^[a-z0-9][a-z0-9-]{0,31}$/.test(r.serviceName))throw new Error('bad identity');if(typeof r.settings.host!=='string'||!['any','listed'].includes(r.settings.admission)||!['auto','always','never'].includes(r.settings.openBrowser)||typeof r.settings.autoStart!=='boolean'||typeof r.settings.restore!=='boolean')throw new Error('bad settings');if(r.settings.port!==undefined&&(!Number.isInteger(r.settings.port)||r.settings.port<1024||r.settings.port>65535))throw new Error('bad port');if(!r.dirs.stateDir.startsWith('/')||!r.dirs.socketPath.startsWith('/'))throw new Error('bad dirs');};
        const check=(input)=>{try{outcome(resolveServiceConfiguration(input));}catch(e){if(!(e instanceof ProjectError)||e.code!=='manifest_error')throw e;}};
        outcome(resolveServiceConfiguration(valid));
        for(let round=0;round<300;round++){
          const arbitrary=Array.from({length:next()%300},()=>String.fromCharCode(next()%65536)).join('');
          check({...valid,projectServiceName:arbitrary});
          const words=Array.from({length:next()%80},()=>vocabulary[next()%vocabulary.length]).join('');
          check({...valid,env:{...valid.env,ARCHER_SERVICE:words,ARCHER_PORT:words,ARCHER_OPEN_BROWSER:words}});
          const pattern='/work/'+Array.from({length:next()%120},()=>vocabulary[next()%4]).join('');
          try{projectPatternMatches(pattern,'/work/project');selectProjectRule('/work/project',[{path:pattern,service:'chosen'}]);}catch(e){if(!(e instanceof ProjectError)||e.code!=='manifest_error')throw e;}
          const edited=JSON.parse(JSON.stringify(valid));const keys=['ARCHER_SERVICE','ARCHER_PORT','ARCHER_ADMISSION','ARCHER_PUBLIC_URL','ARCHER_OPEN_BROWSER','ARCHER_AUTO_START','ARCHER_RESTORE_STATE'];edited.env[keys[next()%keys.length]]=vocabulary[next()%vocabulary.length];check(edited);
        }
        const hostile='/'+'*a'.repeat(2047);const hostilePath='/'+'a'.repeat(2047);if(typeof projectPatternMatches(hostile,hostilePath)!=='boolean')throw new Error('no match outcome');
        const long='/'+'a'.repeat(4094);const rules=Array.from({length:4},(_,i)=>({path:'/'+'*'.repeat(4093)+i,service:'one'}));
        try{selectProjectRule(long,rules);throw new Error('work limit accepted');}catch(e){if(!(e instanceof ProjectError)||e.code!=='manifest_error'||!/work limit/.test(e.message))throw e;}
        console.log('resolver outcomes valid');
      `,
        resolveDir: process.cwd(),
        sourcefile: "resolve-property.ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });
    expect(
      execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10_000 }),
    ).toContain("resolver outcomes valid");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
