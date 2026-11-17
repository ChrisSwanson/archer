import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEED, flowchart, planCorpus, rng, summarise, writeCorpus } from "../../devkit/corpus/scale.mjs";

const digest = (plan) => {
  const hash = createHash("sha256");
  for (const project of plan)
    for (const path of Object.keys(project.files).sort())
      hash.update(`${project.name}/${path}\n${project.files[path]}\n`);
  return hash.digest("hex");
};

test("the same size and seed give the same bytes; another seed gives other bytes", () => {
  assert.equal(digest(planCorpus("M")), digest(planCorpus("M", DEFAULT_SEED)));
  assert.notEqual(digest(planCorpus("M")), digest(planCorpus("M", DEFAULT_SEED + 1)));
});

test("rng is seeded and stays in [0, 1)", () => {
  const a = rng(5),
    b = rng(5);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("M has 250 views, 1,000 notes and 200 comment threads", () => {
  assert.deepEqual(summarise(planCorpus("M")), { projects: 3, views: 250, notes: 1000, threads: 200 });
});

test("L has 1,000 views and 4,000 notes, one project of 257 views with 2,000 threads, and one dense diagram", () => {
  const plan = planCorpus("L");
  const totals = summarise(plan);
  assert.equal(totals.views, 1000);
  assert.equal(totals.notes, 4000);
  const big = plan.find((p) => p.name === "big");
  assert.equal(big.counts.views, 257);
  assert.equal(big.counts.threads, 2000);
  const dense = plan.find((p) => p.name === "dense").files[".archer/diagrams/d0000.mmd"];
  assert.equal(dense.split("\n").filter((l) => /^ {2}n\d+\[/.test(l)).length, 200);
  const edges = dense.split("\n").filter((l) => /@-->\|/.test(l));
  assert.equal(edges.length, 400);
  assert.equal(new Set(edges.map((l) => l.match(/ (e\d+)@/)[1])).size, 400, "edge ids are unique");
});

test("a project registers at most 100 views and leaves the rest to discovery", () => {
  const big = planCorpus("L").find((p) => p.name === "big");
  assert.equal((big.files["archer.toml"].match(/\[\[views\]\]/g) ?? []).length, 100);
  assert.equal(Object.keys(big.files).filter((f) => f.endsWith(".mmd")).length, 257);
});

test("every thread file is valid JSON naming its own target, with unique thread ids across the project", () => {
  for (const project of planCorpus("M")) {
    const seen = new Set();
    for (const [path, text] of Object.entries(project.files).filter(([p]) => p.endsWith(".comments.json"))) {
      const file = JSON.parse(text);
      assert.equal(file.version, 2);
      for (const thread of file.threads) {
        assert.equal(thread.target, file.target);
        assert.match(thread.id, /^[A-Za-z0-9_-]{1,64}$/);
        assert.ok(!seen.has(thread.id), `${project.name}/${path}: duplicate thread id ${thread.id}`);
        seen.add(thread.id);
        if (thread.status === "answered") assert.equal(thread.comments.at(-1).author, "agent");
      }
    }
  }
});

test("a flowchart gives each edge an id, labelled or not", () => {
  const next = rng(1);
  assert.match(flowchart(next, 4, 3, false), /n0 e0@--> n1/);
  assert.match(flowchart(next, 4, 3, true), /n0 e0@-->\|\w+ 0\| n1/);
});

test("writeCorpus writes M to disk, one directory per project with an archer.toml, and S is the stock corpus", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-scale-test-"));
  try {
    const m = writeCorpus("M", join(dir, "m"));
    assert.equal(m.views, 250);
    assert.deepEqual(readdirSync(join(dir, "m")).sort(), ["alpha", "beta", "gamma"]);
    assert.match(readFileSync(join(dir, "m", "gamma", "archer.toml"), "utf8"), /^version = 1/);
    const s = writeCorpus("S", join(dir, "s"));
    assert.equal(s.projects, 3);
    assert.deepEqual(readdirSync(join(dir, "s")).sort(), ["awkward", "journeys", "pageturner"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bigViews cuts only L's big project, to fit under the attach limit until the 256-view cliff is fixed", () => {
  const plan = planCorpus("L", DEFAULT_SEED, { bigViews: 150 });
  assert.equal(plan.find((p) => p.name === "big").counts.views, 150);
  assert.equal(plan.find((p) => p.name === "dense").counts.views, 31);
  assert.equal(summarise(plan).views, 1000 - 107);
});
