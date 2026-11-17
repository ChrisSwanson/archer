import { mkdir, writeFile, readFile, readdir, lstat, realpath, cp, symlink } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute, delimiter } from "node:path";
import { createHash } from "node:crypto";

export interface EvalRunOptions {
  root: string;
  bundleDir: string;
  skillDir: string;
  solver: { prompt: string; files: Record<string, string> };
  caseId: string;
  variant: string;
  cohort: string;
  track: string;
  sourceCommit: string;
  port: number;
  maxCalls?: number;
}
export interface EvalRunPaths {
  root: string;
  projectDir: string;
  promptFile: string;
  runnerFile: string;
  cliFile: string;
  mcpConfigFile: string;
  manifestFile: string;
}

/** Filesystem preparation only. This does not bind a port or prove browser/MCP readiness. */
export async function prepareEvalRun(options: EvalRunOptions): Promise<EvalRunPaths> {
  const { port, solver } = options;
  const root = resolve(options.root);
  try {
    await lstat(root);
    throw new Error("run root already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error("Node >=22.18 is required");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("port must be 1024–65535");
  const maxCalls = options.maxCalls ?? 30;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 30) throw new Error("maxCalls must be 1–30");
  for (const name of Object.keys(solver.files)) {
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      isAbsolute(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("fixture files must be confined relative paths");
    }
  }
  const fixtureNames = Object.keys(solver.files).sort();
  for (const name of fixtureNames) {
    if (fixtureNames.some((other) => other.startsWith(name + "/"))) throw new Error("conflicting fixture paths");
  }
  const bundleDir = await realpath(options.bundleDir),
    skillDir = await realpath(options.skillDir);
  const distribution = await hashes(bundleDir),
    skill = await hashes(skillDir);
  for (const file of ["archer.js", "api.js", "assets/archer-ui.html", "docs/supported-mermaid.md"]) {
    if (!distribution[file]) throw new Error("bundle missing " + file);
  }
  if (!skill["SKILL.md"]) throw new Error("skill missing SKILL.md");
  const projectDir = join(root, "project"),
    promptFile = join(root, "prompt.txt");
  const runnerFile = join(root, "runner.mjs"),
    cliFile = join(root, "bin", "archer");
  const mcpConfigFile = join(root, "mcp.json"),
    manifestFile = join(root, "manifest.json");
  // Exclusive mkdir is the ownership boundary, including concurrent preparations.
  await mkdir(root, { mode: 0o700 });
  for (const path of [
    projectDir,
    join(root, "home"),
    join(root, "config"),
    join(root, "state"),
    join(root, "bin"),
    join(root, "budget"),
    join(root, "plugin", "skills"),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  for (const [name, content] of Object.entries(solver.files)) {
    await mkdir(dirname(join(projectDir, name)), { recursive: true });
    await writeFile(join(projectDir, name), content);
  }
  await writeFile(promptFile, solver.prompt);
  await cp(skillDir, join(root, "plugin", "skills", "archer"), { recursive: true });
  await symlink(bundleDir, join(root, "plugin", "dist"), "dir");
  const privateEnv = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    ARCHER_CONFIG: join(root, "config", "archer.toml"),
    ARCHER_STATE_DIR: join(root, "state"),
    ARCHER_SOCKET: join(root, "state", "archer.sock"),
    ARCHER_FORCE_HTTP: "true",
    ARCHER_HOST: "127.0.0.1",
    ARCHER_PORT: String(port),
    ARCHER_OPEN_BROWSER: "never",
    PATH: [join(root, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  };
  await writeFile(privateEnv.ARCHER_CONFIG, "version = 1\n[service]\n");
  const config = { root, projectDir, privateEnv, maxCalls, traceFile: join(root, "trace.jsonl") };
  await writeFile(runnerFile, runnerSource(config));
  // Exact executable shebang prevents an inherited PATH from selecting an older Node.
  await writeFile(
    cliFile,
    "#!" +
      process.execPath +
      "\n" +
      `const {spawn}=require('node:child_process'); const c=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(runnerFile)},'--archer-cli',${JSON.stringify(process.execPath)},${JSON.stringify(join(bundleDir, "archer.js"))},...process.argv.slice(2)],{stdio:'inherit'}); c.on('error',e=>{console.error(e.message);process.exitCode=127}); c.on('close',(code,signal)=>{process.exitCode=code??(signal?128:1)});\n`,
    { mode: 0o700 },
  );
  await writeFile(
    mcpConfigFile,
    JSON.stringify(
      {
        mcpServers: {
          archer: {
            command: process.execPath,
            args: [runnerFile, process.execPath, join(bundleDir, "archer.js"), "mcp"],
            env: privateEnv,
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        caseId: options.caseId,
        variant: options.variant,
        cohort: options.cohort,
        track: options.track,
        sourceCommit: options.sourceCommit,
        model: null,
        modelAvailability: "record actual resolved model at launch",
        interface: options.cohort,
        node: { version: process.versions.node, executable: process.execPath },
        preflight: "filesystem-ready",
        port,
        maxCalls,
        hashes: {
          fixture: Object.fromEntries(Object.entries(solver.files).map(([name, content]) => [name, digest(content)])),
          prompt: digest(solver.prompt),
          distribution,
          skill,
        },
        limitations: [
          "No network, production compile, presentation or browser preflight performed",
          "Launch Claude client with operator authentication HOME; only its MCP server uses the private runner",
          "CLI trace is not a full MCP protocol trace; capture Claude stream JSON and enforce MCP tool-use limits in the external driver",
          "CLI budget applies to shim invocations, not direct bundle bypasses or MCP operations",
        ],
      },
      null,
      2,
    ),
  );
  return { root, projectDir, promptFile, runnerFile, cliFile, mcpConfigFile, manifestFile };
}

function digest(value: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
async function hashes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  // Iterative walk: neither nesting nor file count can create unbounded recursion.
  const pending = [""];
  let count = 0;
  while (pending.length) {
    const prefix = pending.pop()!;
    if (prefix.split("/").length > 64) throw new Error("artifact nesting exceeds 64");
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      if (++count > 10000) throw new Error("artifact inventory exceeds 10000");
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error("artifact symlinks are refused");
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) result[name] = digest(await readFile(join(directory, name)));
      else throw new Error("artifact must contain regular files");
    }
  }
  return result;
}

function runnerSource(config: object): string {
  return `import {spawn} from 'node:child_process';
import {appendFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const config=${JSON.stringify(config)};
const args=process.argv.slice(2);
const cli=args[0]==='--archer-cli'; if(cli)args.shift();
const id=randomUUID(), started=Date.now();
const emit=value=>appendFileSync(config.traceFile,JSON.stringify({id,time:new Date().toISOString(),...value})+'\\n');
if(cli){
 let reserved=false;
 for(let i=0;i<config.maxCalls;i++){try{mkdirSync(config.root+'/budget/'+i);reserved=true;break}catch(e){if(e.code!=='EEXIST')throw e}}
 if(!reserved){emit({event:'budget-refused',argv:args,cwd:config.projectDir});console.error('Archer CLI invocation budget exhausted');process.exit(75)}
}
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('ARCHER_')));
Object.assign(env,config.privateEnv);
emit({event:'start',argv:args,cwd:config.projectDir,cli});
let stdoutBytes=0,stderrBytes=0,out=[],err=[],outSize=0,errSize=0,launchError;
const cap=65536;
const child=spawn(args[0]??'',args.slice(1),{cwd:config.projectDir,env,stdio:['inherit','pipe','pipe'],shell:false});
child.stdout.on('data',chunk=>{process.stdout.write(chunk);stdoutBytes+=chunk.length;const kept=chunk.subarray(0,Math.max(0,cap-outSize));out.push(kept);outSize+=kept.length});
child.stderr.on('data',chunk=>{process.stderr.write(chunk);stderrBytes+=chunk.length;const kept=chunk.subarray(0,Math.max(0,cap-errSize));err.push(kept);errSize+=kept.length});
child.on('error',error=>{launchError=error.message;process.stderr.write(error.message+'\\n')});
child.on('close',(code,signal)=>{
 const text=chunks=>new TextDecoder('utf-8',{fatal:false}).decode(Buffer.concat(chunks)).replace(/\\uFFFD$/,'');
 emit({event:'end',exitCode:code,signal,launchError,elapsedMs:Date.now()-started,stdout:text(out),stderr:text(err),stdoutBytes,stderrBytes,stdoutTruncated:stdoutBytes>cap,stderrTruncated:stderrBytes>cap});
 process.exitCode=launchError?127:(code??1);
});
`;
}
