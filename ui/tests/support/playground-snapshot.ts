import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inject } from "vitest";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Generate with the production compiler in Node's realm, including in jsdom tests. */
function generate(): string {
  const root = resolve(process.cwd(), "..");
  const source = `import {generatePlaygroundSnapshot} from './site/scripts/playground-snapshot.mts'; console.log(JSON.stringify(await generatePlaygroundSnapshot({repoRoot:process.cwd(), examplesRoot:process.cwd()+'/examples'})));`;
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * The three examples, compiled once per test run (`global-setup.ts` names the file): the first worker to ask
 * generates it under a directory lock, the others wait for the file. Each caller gets its own copy.
 */
export function exampleSnapshot(): PlaygroundSnapshot {
  const path = inject("playgroundSnapshotPath");
  if (!existsSync(path)) {
    let owner = false;
    try {
      mkdirSync(`${path}.lock`);
      owner = true;
    } catch {
      /* Another worker is generating it. */
    }
    if (owner) {
      writeFileSync(`${path}.partial`, generate());
      renameSync(`${path}.partial`, path);
    } else {
      const deadline = Date.now() + 60_000;
      while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error("The example snapshot was not generated in time.");
        sleep(50);
      }
    }
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
