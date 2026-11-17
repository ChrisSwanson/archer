import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { diagramDescription } from "../../src/project/describe.ts";
import { compileEmbedded, readEmbeddedIn } from "../../src/notes/embedded.ts";
import { compileDiagram, findProject, listDiagrams } from "../../src/project/index.ts";
import { addressable, parseEmphasis } from "../../src/service/emphasis.ts";
import { resolveWalkthrough } from "../../src/walkthroughs/resolve.ts";
import { validateWalkthroughsFile } from "../../src/walkthroughs/store.ts";

const ROOT = resolve(import.meta.dirname, "../../../examples/rfc-1149-ipoac");
const project = findProject(ROOT);
const diagrams = listDiagrams(project);
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const guide = () => read(".archer/notes/reading-guide.md");

// Pin all preserved artifacts, including the Markdown reproductions: prose and pagination stay fixed.
test("avian RFC source artifacts stay byte-for-byte unchanged", () => {
  const hashes = {
    "sources/rfc1149.txt": "a8660fa4f47bd5e3db1cd5d5baad983d8b6f3f1e8a1a04b8552f3c2ce8f33c18",
    "sources/rfc2549.txt": "646b43b5d718913d6211e2c18b2b3b667cf6eaa76a2493e55b1de5ca04c2578e",
    ".archer/notes/rfc1149.md": "1f4284c70dd600a08959f6ee99ada29d599164298234ed2e75ecb3dc51506d38",
    ".archer/notes/rfc2549.md": "c4c801e5d528cc4807a570d293347bb6a579e03d41d3f1a270a4936d8bb9fbe6",
  };
  for (const [path, hash] of Object.entries(hashes))
    expect(
      createHash("sha256")
        .update(readFileSync(join(ROOT, path)))
        .digest("hex"),
      path,
    ).toBe(hash);
});

test("avian casebook gives two source-backed questions and real review actions", () => {
  const text = guide();
  for (const title of ["When can a carrier leave?", "What does the traffic picture actually show?"])
    expect(text).toContain(`## ${title}`);
  expect(text.match(/\*\*Agent interpretation:\*\*/g)).toHaveLength(2);
  expect(text.match(/\*\*Gap:\*\*/g)).toHaveLength(2);
  expect(text.match(/\*\*Challenge your agent:\*\*/g)).toHaveLength(2);
  expect(text).toContain("## Try the interaction");
  expect(text).toContain("archer emphasis set --file demo/emphasis/queue-release.json");
  expect(text).toContain("archer emphasis set --file demo/emphasis/datagram-flight.json");
  const original = read(".archer/notes/rfc2549.md");
  const quote = original.slice(
    original.indexOf("   The service level is indicated"),
    original.indexOf("   For secure networks"),
  );
  // Prose is quoted evidence that wraps; only its indentation/presentation changes.
  expect(text).toContain(
    quote
      .trimEnd()
      .split("\n")
      .map((line) => `> ${line.trim()}`)
      .join("\n"),
  );
  const figure = original.match(/```text\n( {8}Alt \|[\s\S]*?)```/u)?.[1];
  expect(figure).toBeDefined();
  expect(text).toContain(figure);
  expect(read("README.md")).toContain("When can a carrier leave?");
  expect(read("README.md")).toContain("walkthrough");
  expect(read("README.md")).toContain("select");
});

test("every avian derivative note carries the full applicable notice and valid local links", () => {
  const copyright = read(".archer/notes/rfc2549.md").split("## Full Copyright Statement\n")[1]?.trim();
  expect(copyright).toBeDefined();
  for (const file of [
    "README.md",
    "NOTICE.md",
    ...readdirSync(join(ROOT, ".archer/notes"))
      .filter((name) => !/^rfc\d+\.md$/.test(name))
      .map((name) => `.archer/notes/${name}`),
  ]) {
    const text = read(file);
    expect(text, file).toContain(copyright);
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = match[1]!;
      if (/^[a-z]+:/u.test(href)) continue;
      const target = resolve(dirname(join(ROOT, file)), href.split("#")[0]!);
      expect(target.startsWith(`${ROOT}/`), href).toBe(true);
      expect(existsSync(target), href).toBe(true);
    }
  }
});

test("avian canonical and named inline figures compile through production", async () => {
  expect(project.problems).toEqual([]);
  for (const diagram of diagrams) {
    const compiled = await compileDiagram(project, diagram);
    expect(
      compiled.diagnostics.filter((d) => d.severity !== "info"),
      diagram.path,
    ).toEqual([]);
    expect(compiled.envelope, diagram.path).not.toBeNull();
  }
  const inline = readEmbeddedIn(project, "notes/reading-guide.md");
  expect(inline.map((figure) => figure.name)).toEqual(["paper-datagram", "traffic-scene"]);
  for (const figure of inline) {
    expect(figure.explicit).toBe(true);
    const compiled = await compileEmbedded(figure);
    expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(compiled.envelope).not.toBeNull();
  }
});

test("the avian queue walkthrough is current on its graph host", async () => {
  const file = JSON.parse(read(".archer/diagrams/qos-queues.walkthroughs.json"));
  const parsed = validateWalkthroughsFile(file);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.problem);
  expect(parsed.file.target).toBe("view:qos-queues");
  expect(parsed.file.walkthroughs).toHaveLength(1);
  const diagram = diagrams.find((entry) => entry.view?.id === "qos-queues")!;
  const { envelope } = await compileDiagram(project, diagram);
  if (envelope === null) throw new Error("queue diagram must compile");
  for (const walkthrough of parsed.file.walkthroughs) {
    expect(walkthrough.author).toBe("agent");
    const resolution = resolveWalkthrough(walkthrough, envelope.model);
    expect({ status: resolution.status, changed: resolution.changed }).toEqual({ status: "current", changed: [] });
  }
});

test("avian emphasis recipes resolve and pin the intended sequence message", async () => {
  for (const name of ["queue-release.json", "datagram-flight.json"]) {
    const raw = JSON.parse(read(`demo/emphasis/${name}`));
    const diagram = diagrams.find((entry) => entry.view?.id === raw.viewId);
    expect(diagram, name).toBeDefined();
    const { envelope } = await compileDiagram(project, diagram!);
    if (envelope === null) throw new Error("recipe host must compile");
    const parsed = parseEmphasis(raw, raw.viewId, addressable(envelope.model));
    expect(parsed.ok, name).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    if (name === "datagram-flight.json") {
      expect(envelope.model.type).toBe("sequence-trace");
      if (envelope.model.type !== "sequence-trace") throw new Error("expected sequence");
      const ids = parsed.emphasis.groups.flatMap((group) => group.edges);
      expect(ids).toHaveLength(1);
      const event = envelope.model.events.find((entry) => entry.type === "message" && entry.id === ids[0]);
      expect(event).toMatchObject({ type: "message", from: "carrier", to: "receiver", label: "Carry datagram" });
    }
  }
});

test("traffic artwork explains its rising, high and falling outline with unknown quantities explicit", async () => {
  const figure = readEmbeddedIn(project, "notes/reading-guide.md").find((f) => f.name === "traffic-scene")!;
  const { envelope } = await compileEmbedded(figure);
  if (envelope?.model.type !== "freeform-graph") throw new Error("expected scene graph");
  expect(envelope.model.nodes.map((node) => node.label)).toEqual(
    expect.arrayContaining([
      "Rising Dots",
      "High Dots",
      "Falling Dots",
      "Alt: 1k and 2k",
      "Units and Horizontal Axis Unspecified",
    ]),
  );
  expect(envelope.model.edges.find((edge) => edge.id === "arrival")).toBeUndefined();
  expect(guide()).toContain("two 10g weights");
  expect(guide()).toContain("carrier on the other side");
  expect(guide()).toContain("log entries");
  expect(guide()).toContain("no weight-to-priority formula");
});

test("each canonical figure declares a purpose beyond its title", () => {
  for (const entry of listDiagrams(project)) {
    const description = diagramDescription(read(`.archer/${entry.path}`));
    expect(description?.descriptionFrom, entry.path).toBe("comment");
    expect(description?.description, entry.path).not.toBe(entry.view?.title);
    expect(description?.description.split(" ").length, entry.path).toBeGreaterThan(8);
  }
});

test("avian reader instructions omit test setup commentary", () => {
  expect(guide()).not.toMatch(/seeded|test harness|example tests/);
  expect(guide()).toContain("archer emphasis set --file demo/emphasis/queue-release.json");
});
