import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/project.ts";
import { withSourceWriterLock } from "../../src/project/source-writer.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { FLOW, removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);
test("two real processes with the same source revision produce one winner and one conflict", async () => {
  const root = tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW });
  const module = pathToFileURL(join(import.meta.dirname, "../../src/project/source-writer.ts")).href;
  const projectModule = pathToFileURL(join(import.meta.dirname, "../../src/project/project.ts")).href;
  const code = `const {applySource}=await import(${JSON.stringify(module)});const {findProject}=await import(${JSON.stringify(projectModule)});process.stdout.write('ready\\n');process.stdin.once('data',async()=>{try{const r=await applySource(findProject(process.argv[1]),{kind:'view',viewId:'a'},process.argv[2],process.argv[3]);process.stdout.write(JSON.stringify({outcome:r.outcome,source:r.after.toString()})+'\\n');}catch(e){process.stdout.write(JSON.stringify({code:e.code})+'\\n');}process.stdin.destroy();});`;
  const expected = revisionOf(Buffer.from(FLOW));
  const children = ["One", "Two"].map((label) =>
    spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code, root, expected, FLOW.replace("Client", label)],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  const outputs = children.map(() => ({ stdout: "", stderr: "" }));
  try {
    await Promise.all(
      children.map(
        (child, i) =>
          new Promise<void>((resolve, reject) => {
            child.stdout.on("data", (chunk: Buffer) => {
              outputs[i]!.stdout += chunk.toString();
              if (outputs[i]!.stdout.includes("ready\n")) resolve();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              outputs[i]!.stderr += chunk.toString();
            });
            child.once("error", reject);
            child.once("exit", () => {
              if (!outputs[i]!.stdout.includes("ready\n")) reject(new Error(outputs[i]!.stderr));
            });
          }),
      ),
    );
    const exited = children.map((child) => once(child, "exit"));
    children.forEach((child) => child.stdin.end("go\n"));
    const statuses = await Promise.all(exited);
    expect(statuses).toEqual([
      [0, null],
      [0, null],
    ]);
    const results = outputs.map(
      (o) => JSON.parse(o.stdout.trim().split("\n").at(-1)!) as { outcome?: string; code?: string; source?: string },
    );
    expect(results.filter((r) => r.outcome === "updated")).toHaveLength(1);
    expect(results.filter((r) => r.code === "revision_conflict")).toHaveLength(1);
    expect(readFileSync(join(findProject(root).folder, "a.mmd"), "utf8")).toBe(
      results.find((r) => r.outcome === "updated")!.source,
    );
  } finally {
    children.forEach((child) => child.kill());
  }
}, 20_000);

test("a real live holder causes named bounded source_busy without invoking contender work", async () => {
  const root = tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW });
  const module = pathToFileURL(join(import.meta.dirname, "../../src/project/source-writer.ts")).href;
  const projectModule = pathToFileURL(join(import.meta.dirname, "../../src/project/project.ts")).href;
  const code = `import {existsSync} from 'node:fs';const {withSourceWriterLock}=await import(${JSON.stringify(module)});const {findProject}=await import(${JSON.stringify(projectModule)});withSourceWriterLock(findProject(process.argv[1]),'a.mmd',()=>{process.stdout.write('held\\n');const end=Date.now()+5000;while(!existsSync(process.argv[2])){if(Date.now()>end)throw new Error('holder release deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}});`;
  const release = join(root, "release");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, root, release], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  try {
    const exited = once(child, "exit");
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("held\n")) resolve();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", () => {
        if (!output.includes("held\n")) reject(new Error(error));
      });
    });
    let entered = false;
    expect(() =>
      withSourceWriterLock(
        findProject(root),
        "a.mmd",
        () => {
          entered = true;
        },
        20,
      ),
    ).toThrowError(expect.objectContaining({ code: "source_busy" }));
    expect(entered).toBe(false);
    expect(readFileSync(join(root, ".archer/a.mmd"), "utf8")).toBe(FLOW);
    writeFileSync(release, "go");
    expect(await exited).toEqual([0, null]);
  } finally {
    child.kill();
  }
}, 15_000);
