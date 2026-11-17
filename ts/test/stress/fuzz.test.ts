import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { compileView, runStep, shrink, rng } from "./harness.ts";
import { genOp, MUTATIONS } from "./ops.ts";
import type { DiagramEdit } from "../../src/authoring/diagram-edit.ts";

const ROOT = join(import.meta.dirname, "../../..");
function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function corpus(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  for (const base of [join(ROOT, "tools/devkit/corpus"), join(ROOT, "ts/test/fixtures/pageturner")])
    for (const p of walk(base)) {
      const text = readFileSync(p, "utf8");
      if (p.endsWith(".mmd")) out.push({ name: p.slice(ROOT.length + 1), source: text });
      else if (p.endsWith(".md")) {
        let i = 0;
        for (const m of text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g))
          out.push({ name: `${p.slice(ROOT.length + 1)}#${i++}`, source: m[1]! });
      }
    }
  if (process.env.STRESS_ONLY === "empty") out.length = 0;
  for (const h of [
    "flowchart LR",
    "flowchart TB",
    "sequenceDiagram",
    "erDiagram",
    "stateDiagram-v2",
    "C4Context",
    "C4Container",
    "C4Component",
  ])
    for (const tail of ["\n", "", "\r\n"]) out.push({ name: `empty:${h}${JSON.stringify(tail)}`, source: h + tail });
  return out;
}
// Opt-in only (`npm run test:stress`); see vitest.config.ts. The report goes to
// STRESS_OUT, or to a fresh directory under the system temp dir.
const OUT = process.env.STRESS_OUT ?? join(mkdtempSync(join(tmpdir(), "archer-stress-")), "stress-raw.json");
const RUNS = Number(process.env.STRESS_RUNS ?? 3);
const STEPS = Number(process.env.STRESS_STEPS ?? 25);
const SEED = Number(process.env.STRESS_SEED ?? 1);

test("fuzz editors", { timeout: 3_000_000 }, async () => {
  const failures = new Map<string, any>();
  const refusals = new Map<string, any>();
  const stats: Record<string, number> = {};
  const times: Record<string, number[]> = {};
  const bump = (k: string) => {
    stats[k] = (stats[k] ?? 0) + 1;
  };
  const files = corpus();
  const unusable: string[] = [];
  for (const f of files) {
    for (let run = 0; run < RUNS; run++) {
      const r = rng(SEED * 1000 + run * 77 + f.name.length * 13 + f.source.length);
      // Build a mutated start that still compiles.
      let src = f.source;
      const applied: string[] = [];
      if (run > 0)
        for (const [name, fn] of Object.entries(MUTATIONS)) {
          if (!r.chance(run === 1 ? 0.2 : 0.35)) continue;
          const m = fn(src, r);
          if (m === null) continue;
          if (await compileView(m)) {
            src = m;
            applied.push(name);
          }
        }
      let v = await compileView(src);
      if (!v) {
        if (run === 0) unusable.push(f.name);
        continue;
      }
      const log: DiagramEdit[] = [];
      for (let step = 0; step < STEPS; step++) {
        const op = genOp(r, v);
        const res = await runStep(src, op, v);
        log.push(op);
        const fam = v.family;
        (times[`${fam}:${op.kind}`] ??= []).push(res.ms);
        bump(`${fam}:${op.kind}:${res.ok ? "ok" : (res.code ?? "FAIL")}`);
        if (res.failure) {
          const key = `${fam}|${op.kind}|${res.failure.kind}|${res.failure.kind === "model-mismatch" ? res.failure.detail.replace(/[0-9]+/g, "#").slice(0, 40) : ""}`;
          const prior = failures.get(key);
          if (!prior || prior.source.length > src.length) {
            const kind = res.failure.kind;
            const small = kind === "slow" ? src : await shrink(src, op, (x) => x.failure?.kind === kind);
            const again = await runStep(small, op);
            const cand = {
              key,
              family: fam,
              file: f.name,
              mutations: applied,
              op,
              failure: again.failure ?? res.failure,
              source: small,
              originalLength: src.length,
              steps: log.length,
              count: (prior?.count ?? 0) + 1,
            };
            if (!prior || small.length < prior.source.length) failures.set(key, cand);
            else prior.count++;
          } else prior.count++;
          break; // state after failure is unreliable; restart not needed
        }
        if (!res.ok) {
          const key = `${fam}|${op.kind}|${res.code}`;
          const prior = refusals.get(key);
          if (!prior) refusals.set(key, { key, op, source: src, file: f.name, mutations: applied, count: 1 });
          else {
            prior.count++;
            if (src.length < prior.source.length)
              Object.assign(prior, { op, source: src, file: f.name, mutations: applied });
          }
        } else if (res.source !== src) {
          src = res.source;
          v = (await compileView(src)) ?? v;
        }
      }
    }
  }
  // Shrink a bounded number of refusal repros.
  for (const rf of refusals.values()) {
    const code = rf.key.split("|")[2];
    rf.source = await shrink(rf.source, rf.op, (x) => !x.ok && x.code === code && !x.failure, 4000).catch(
      () => rf.source,
    );
  }
  const tstat = Object.fromEntries(
    Object.entries(times).map(([k, a]) => {
      a.sort((x, y) => x - y);
      return [k, { n: a.length, p50: +a[a.length >> 1]!.toFixed(1), max: +a.at(-1)!.toFixed(1) }];
    }),
  );
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      { unusable, stats, tstat, failures: [...failures.values()], refusals: [...refusals.values()] },
      null,
      1,
    ),
  );
  console.log(
    `report ${OUT}\ndiagrams ${files.length} unusable ${unusable.length} failures ${failures.size} refusal-keys ${refusals.size}`,
  );
});
