// The project model outside the service (ADR 0036 A2): each operation compiles the inventory once,
// and a long-lived session recompiles only views whose source revision moved.
import { afterEach, expect, test } from "vitest";
import { ProjectModelCache } from "../../src/application/project-model.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir, write } from "../project/support.ts";

afterEach(removeTempDirs);

const CONTEXT = `C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys")\n`;
const FLOW = `flowchart LR\n  shop[Shop]:::system\n  pay[Payments]:::system\n  shop e1@--> pay\n`;
const fence = (front: string, body: string): string =>
  `---\n${front}\n---\n# Checkout\n\n\`\`\`mermaid\n%% archer-id: flow\n${body}\`\`\`\n`;

function project(): string {
  return tempDir({
    "archer.toml": "version = 1\n",
    ".archer/diagrams/context.mmd": CONTEXT,
    ".archer/diagrams/broken.mmd": "flowchart LR\n  a[A] --> b[B]\n",
    ".archer/notes/checkout.md": fence("author: agent", FLOW),
  });
}

test("one build compiles every view and names those it could not compile", async () => {
  const root = project();
  const cache = new ProjectModelCache();
  const built = await cache.build(findProject(root));
  expect(built.model.elements.map((e) => e.id)).toEqual(["pay", "shop", "user"]);
  expect(built.notCompiled).toEqual(["broken"]);
  expect(built.compiled).toBe(3);
});

test("a later build recompiles only the views whose source moved", async () => {
  const root = project();
  const cache = new ProjectModelCache();
  await cache.build(findProject(root));
  const warm = await cache.build(findProject(root));
  expect(warm.compiled).toBe(0);
  write(root, ".archer/diagrams/context.mmd", CONTEXT.replace('"Shop"', '"Web shop"'));
  const moved = await cache.build(findProject(root));
  expect(moved.compiled).toBe(1);
  expect(moved.model.elements.find((e) => e.id === "shop")?.name).toBe("Web shop");
});

test("the note's status and based-on are read with no recompile", async () => {
  const root = project();
  const cache = new ProjectModelCache();
  await cache.build(findProject(root));
  write(root, ".archer/notes/checkout.md", fence("author: agent\nstatus: proposed", FLOW));
  const proposed = await cache.build(findProject(root));
  expect(proposed.compiled).toBe(0);
  expect(proposed.model.elements.map((e) => e.id)).toEqual(["shop", "user"]);
  write(root, ".archer/notes/checkout.md", fence("author: agent\nbased-on: context@sha256:00", FLOW));
  const copy = await cache.build(findProject(root));
  expect(copy.model.views.find((v) => v.id === "notes/checkout.md#flow")).toMatchObject({
    basedOn: "context@sha256:00",
    contributes: false,
  });
});

test("a session keeps a view's last good model while its source does not compile", async () => {
  const root = project();
  const cache = new ProjectModelCache();
  await cache.build(findProject(root));
  write(root, ".archer/diagrams/context.mmd", "C4Context\nPerson(user\n");
  const failing = await cache.build(findProject(root));
  expect(failing.model.elements.find((e) => e.id === "shop")?.name).toBe("Shop");
  expect(failing.notCompiled).toEqual(["broken"]);
  expect(failing.failing).toEqual(["broken", "context"]);
});
