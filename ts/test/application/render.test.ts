import { existsSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { FLOW, tempDir, removeTempDirs } from "../project/support.ts";
const renderer = new URL("../../src/application/render.ts", import.meta.url);
afterEach(removeTempDirs);
test("readable model results retain actionable IDs and complete revisions without requiring structuredContent", async () => {
  expect(existsSync(renderer), "neutral readable operation renderer exists").toBe(true);
  const { renderOperation } = await import(renderer.href);
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const result = await app.call("read_diagram", { viewId: "flow" });
    const text = renderOperation("read_diagram", result);
    expect(text).toContain('node id="a" label="Client"');
    expect(text).toContain('edge id="e1" source="a" target="b"');
    expect(text).toContain(String(result.structured.sourceRevision));
    expect(text).toContain(String(result.structured.modelRevision));
    expect(text).toContain("outputFormat=json");
    expect(text).toContain("exact Mermaid source");
    expect(text).not.toContain("structuredContent");
  } finally {
    app.close();
  }
});

test("compact output reduces representative model size without dropping nodes or edges", async () => {
  const { renderOperation } = await import(renderer.href);
  const source =
    "flowchart LR\n" +
    Array.from({ length: 71 }, (_, i) => `  n${i}[Service ${i}]\n`).join("") +
    Array.from({ length: 70 }, (_, i) => `  n${i} edge${i}@--> n${i + 1}\n`).join("");
  const app = createApplication({ cwd: tempDir({ ".archer/large.mmd": source }) });
  try {
    const result = await app.call("read_diagram", { viewId: "large" });
    expect(result.structured.modelRevision).not.toBeNull();
    const text = renderOperation("read_diagram", result);
    for (let i = 0; i < 70; i++) {
      expect(text).toContain(`node id="n${i}"`);
      expect(text).toContain(`edge id="edge${i}" source="n${i}" target="n${i + 1}"`);
    }
    expect(text.length).toBeLessThan(JSON.stringify(result.structured, null, 2).length * 0.75);
  } finally {
    app.close();
  }
});

test("failed source output distinguishes source from last valid model and includes complete diagnostics", async () => {
  const { renderOperation } = await import(renderer.href);
  const { write, BROKEN } = await import("../project/support.ts");
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd: root });
  try {
    const good = await app.call("read_diagram", { viewId: "flow" });
    write(root, ".archer/flow.mmd", BROKEN);
    const bad = await app.call("read_diagram", { viewId: "flow" });
    const text = renderOperation("read_diagram", bad);
    expect(text).toContain("compile failed");
    expect(text).toContain(String(good.structured.modelRevision));
    expect(text).toContain(String(bad.structured.sourceRevision));
    expect(bad.structured.source).toMatchObject({ text: BROKEN });
    expect(text).toContain("exact Mermaid source");
    expect(text).not.toContain("structuredContent");
    expect(text).toContain("every edge needs a stable ID");
  } finally {
    app.close();
  }
});

test("comment output preserves complete feedback, anchors and actionable revisions through the shared operations", async () => {
  const { renderOperation } = await import(renderer.href);
  const { CommentsStore, elementsOf } = await import("../../src/comments/store.ts");
  const { findProject } = await import("../../src/project/index.ts");
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const store = new CommentsStore(findProject(root));
  const body =
    "Full canvas must remain usable.\nCustomer needs a readable arrow. " +
    "Please keep this feedback intact. ".repeat(50);
  const place = {
    target: "view:flow" as const,
    path: "flow.comments.json",
    subject: {
      kind: "view" as const,
      elements: elementsOf({ type: "freeform-graph", nodes: [{ id: "a", label: "Client" }], edges: [], groups: [] }),
    },
  };
  const thread = store.create(place, { anchor: { kind: "node", id: "a", label: "Client" }, body }).value;
  store.submit();
  const app = createApplication({ cwd: root });
  try {
    const read = await app.call("get_comments");
    const text = renderOperation("get_comments", read);
    expect(text).toContain(thread.id);
    expect(text).toContain("node a");
    expect(text).toContain(JSON.stringify(body));
    expect(text).toContain("revision 1");
    expect(text).toContain("data to weigh");
    const reply = await app.call("reply_comment", {
      threadId: thread.id,
      expectedRevision: 1,
      body: "I adjusted the arrow.",
    });
    const answered = renderOperation("reply_comment", reply);
    expect(answered).toContain(thread.id);
    expect(answered).toContain(`revision=${reply.structured.revision}`);
    expect(answered).toContain("I adjusted the arrow.");
  } finally {
    app.close();
  }
});

test("write and validation output retain full revisions and compile status for the next operation", async () => {
  const { renderOperation } = await import(renderer.href);
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const read = await app.call("read_diagram", { viewId: "flow" });
    const source = FLOW.replace("API", "Backend");
    const valid = await app.call("validate_diagram", { viewId: "flow", source });
    expect(renderOperation("validate_diagram", valid)).toContain(String(valid.structured.revision));
    const written = await app.call("write_diagram", {
      viewId: "flow",
      source,
      expectedRevision: read.structured.sourceRevision,
    });
    const text = renderOperation("write_diagram", written);
    expect(text).toContain(String(written.structured.sourceRevision));
    expect(text).toContain('status "compiled"');
  } finally {
    app.close();
  }
});

import { loadFixtures } from "../mermaid/support/fixtures.ts";

test.each(loadFixtures())(
  "readable $name model retains every addressable ID, including ordered nested events",
  async ({ source }) => {
    const { renderOperation } = await import(renderer.href);
    const app = createApplication({ cwd: tempDir({ "archer.toml": "version = 1\n", ".archer/diagram.mmd": source }) });
    try {
      await app.call("register_diagram", { sourcePath: "diagram.mmd" });
      const result = await app.call("read_diagram", { viewId: "diagram" });
      const envelope = result.structured.envelope as { model: Record<string, unknown> };
      expect(envelope).not.toBeNull();
      const text = renderOperation("read_diagram", result);
      expect(text).toContain(String(envelope.model.type));
      const identifiers: string[] = [];
      function collect(value: unknown): void {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }
        for (const [key, entry] of Object.entries(value)) {
          if (key === "id" && typeof entry === "string") identifiers.push(entry);
          collect(entry);
        }
      }
      collect(envelope.model);
      for (const id of identifiers) expect(text).toContain(`id=${JSON.stringify(id)}`);
      if (envelope.model.type === "sequence-trace") {
        const positions = identifiers.map((id) => text.indexOf(`id=${JSON.stringify(id)}`));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
    } finally {
      app.close();
    }
  },
);

test("live readable emphasis and context retain group targets and presentation IDs", async () => {
  const { renderOperation } = await import(renderer.href);
  const { service, project, cleanUp } = await import("../service/support.ts");
  const { connectService } = await import("../../src/service/service-client.ts");
  const { svc } = await service();
  const app = createApplication({
    cwd: project(),
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  try {
    const presented = await app.call("present_diagram", { viewId: "flow", annotation: "Customer checkout" });
    const presentation = presented.structured.presentation as { presentationId: string };
    const current = renderOperation("get_presentation_context", await app.call("get_presentation_context"));
    expect(current).toContain(presentation.presentationId);
    expect(current).toContain('viewId="flow"');
    expect(current).toContain("Customer checkout");
    const set = await app.call("set_emphasis", {
      viewId: "flow",
      id: "checkout",
      groups: [{ id: "customers", label: "Customer", nodes: ["a"], edges: ["e1"], style: "highlight" }],
    });
    const applied = renderOperation("set_emphasis", set);
    expect(applied).toContain('id="checkout"');
    expect(applied).toContain('id="customers"');
    expect(applied).toContain('nodes=["a"]');
    expect(applied).toContain('edges=["e1"]');
    const listed = renderOperation("list_emphases", await app.call("list_emphases"));
    expect(listed).toContain('view "flow"');
    expect(listed).toContain('id="checkout"');
    expect(listed).toContain('nodes=["a"]');
  } finally {
    app.close();
    await cleanUp();
  }
});

test("readable boundary handles arbitrary, vocabulary and mutated values on a small stack within a clock", async () => {
  const { execFileSync } = await import("node:child_process");
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  let valid;
  try {
    valid = await app.call("read_diagram", { viewId: "flow" });
  } finally {
    app.close();
  }
  const code = `
    import assert from 'node:assert/strict';
    import { renderOperation, ReadableOutputError } from ${JSON.stringify(renderer.href)};
    let seed = 8219;
    function next() { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }
    const words = ['viewId','id','model','source','target','nodes','edges','groups','events','customer','flow','compile','status','revision','__proto__'];
    function value(depth = 0, vocabulary = false) {
      const roll = next();
      if (depth > 4 || roll < .4) return [null,true,false,0,17,'',vocabulary ? words[Math.floor(next()*words.length)] : String(next())][Math.floor(next()*7)];
      if (roll < .65) return Array.from({length:Math.floor(next()*4)}, () => value(depth+1,vocabulary));
      return Object.fromEntries(Array.from({length:Math.floor(next()*4)}, () => [words[Math.floor(next()*words.length)], value(depth+1,vocabulary)]));
    }
    const valid = ${JSON.stringify(valid)};
    function check(result, name='future_admin_operation') {
      try { assert.equal(typeof renderOperation(name,result),'string'); }
      catch(error) { assert.ok(error instanceof ReadableOutputError, String(error)); }
    }
    for(let i=0;i<1500;i++) {
      check({text:'result',structured:{data:value()}});
      check({text:'result',structured:{data:value(0,true)}});
      check({...valid,structured:{...valid.structured,[words[Math.floor(next()*words.length)]]:value(0,true)}}, 'read_diagram');
    }
    let deep={}; let cursor=deep;
    for(let i=0;i<10000;i++) { cursor.child={}; cursor=cursor.child; }
    assert.throws(()=>renderOperation('future',{text:'',structured:deep}),ReadableOutputError);
    const cycle={}; cycle.self=cycle;
    assert.throws(()=>renderOperation('future',{text:'',structured:cycle}),ReadableOutputError);
    let limit={}; cursor=limit;
    for(let i=0;i<255;i++) { cursor.child={}; cursor=cursor.child; }
    assert.equal(typeof renderOperation('future',{text:'',structured:{value:limit}}),'string');
    assert.throws(()=>renderOperation('future',null),ReadableOutputError);
    console.log('4500 readable boundary cases; deep/cyclic values refused; exact depth limit passed');
  `;
  const output = execFileSync(
    process.execPath,
    ["--stack_size=256", "--import", "tsx", "--input-type=module", "-e", code],
    { cwd: new URL("../..", import.meta.url), timeout: 15_000, encoding: "utf8" },
  );
  expect(output).toContain("4500 readable boundary cases");
});

test.each(["read_diagram", "list_diagrams", "list_emphases"])(
  "%s refuses oversized public results by name before allocating output rows",
  async (name) => {
    const { renderOperation, ReadableOutputError } = await import(renderer.href);
    const entries = Array.from({ length: 200_000 }, () => ({ id: "a", label: "Client" }));
    const structured =
      name === "read_diagram"
        ? {
            envelope: {
              revision: "sha256:example",
              model: { type: "freeform-graph", nodes: entries, edges: [], groups: [] },
            },
          }
        : name === "list_diagrams"
          ? { views: entries }
          : { views: [{ viewId: "flow", emphases: entries }] };
    expect(() => renderOperation(name, { text: "result", structured })).toThrow(ReadableOutputError);
  },
);

test("readable budget is shared across individually bounded model arrays", async () => {
  const { renderOperation, ReadableOutputError } = await import(renderer.href);
  const structured = {
    envelope: {
      model: {
        type: "freeform-graph",
        nodes: Array.from({ length: 2_500 }, () => ({ id: "a", label: "Client" })),
        edges: Array.from({ length: 2_500 }, () => ({ id: "e", source: "a", target: "b" })),
        groups: [],
      },
    },
  };
  expect(() => renderOperation("read_diagram", { text: "result", structured })).toThrow(ReadableOutputError);
});

// In the evals Haiku asked for text output and its answer lost the URL: the readable result
// buried it after the whole model, and dropped the note's page (docs/evaluations/eval-baseline.md).
test("readable present_diagram leads with the page URL and the note's page, without the model", async () => {
  const { renderOperation } = await import(renderer.href);
  const { connectService } = await import("../../src/service/service-client.ts");
  const { cleanUp, project, service, write } = await import("../service/support.ts");
  const root = project();
  write(
    root,
    ".archer/notes/guide.md",
    "---\nauthor: agent\n---\n# Guide\n\n```mermaid\n%% archer-id: flow\nflowchart LR\n  a[Vault] e1@--> b[API]\n```\n",
  );
  const { svc } = await service();
  const app = createApplication({ cwd: root, ensureService: () => connectService(svc.socketPath) });
  try {
    const presented = await app.call("present_diagram", { viewId: "notes/guide.md#flow" });
    const text = renderOperation("present_diagram", presented);
    // The page, then the note's page, each alone on its line before anything else.
    const lines = text.split("\n");
    expect(lines[1]).toBe(String((presented.structured.ui as { url: string }).url));
    expect(lines[3]).toBe(String(presented.structured.noteUrl));
    expect(text).toContain(String((presented.structured.presentation as { presentationId: string }).presentationId));
    expect(text).not.toContain("node id=");
    // With an emphasis, the readable result says what it set, after the URLs.
    const emphasised = await app.call("present_diagram", {
      viewId: "notes/guide.md#flow",
      emphasis: { id: "path", groups: [{ id: "g", label: "Path", style: "flow", edges: ["e1"] }] },
    });
    const readable = renderOperation("present_diagram", emphasised);
    expect(readable.split("\n")[1]).toBe(String((emphasised.structured.ui as { url: string }).url));
    expect(readable).toMatch(/\nemphasis id="path" viewId="notes\/guide\.md#flow" .*edges=\["e1"\]/);
  } finally {
    app.close();
    await cleanUp();
  }
});
