import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test.runIf(process.platform !== "win32")(
  "a regular file replaced by a FIFO before open is refused without blocking",
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "archer-config-fifo-"));
    const output = join(scratch, "fifo-race.cjs");
    try {
      await build({
        stdin: {
          contents: `
        import {execFileSync} from "node:child_process";
        import {chmodSync,renameSync,writeFileSync} from "node:fs";
        import {join} from "node:path";
        import {CONFIG_FILE_SYSTEM,readGlobalConfigWithFileSystem} from ${JSON.stringify(resolve("src/config/index.ts"))};
        import {ProjectError} from ${JSON.stringify(resolve("src/project/errors.ts"))};
        const root=process.argv[2], path=join(root,"archer.toml"), fifo=join(root,"replacement");
        writeFileSync(path,"version = 1\\n",{mode:0o600}); execFileSync("mkfifo",[fifo]); chmodSync(fifo,0o600);
        const fs={...CONFIG_FILE_SYSTEM,openSync:(target,flags)=>{renameSync(path,join(root,"original"));renameSync(fifo,path);return CONFIG_FILE_SYSTEM.openSync(target,flags);}};
        try{readGlobalConfigWithFileSystem(path,{principal:"user"},fs);throw new Error("accepted FIFO");}
        catch(error){if(!(error instanceof ProjectError)||error.code!=="untrusted_manifest")throw error;}
        console.log("FIFO refused");
      `,
          resolveDir: process.cwd(),
          sourcefile: "fifo-race.ts",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: output,
        logLevel: "silent",
      });
      expect(execFileSync(process.execPath, [output, scratch], { encoding: "utf8", timeout: 2_000 })).toContain(
        "FIFO refused",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  30_000,
);
