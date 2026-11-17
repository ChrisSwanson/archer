// find_elements (ADR 0036 §8, A1, A2): the service's model when one runs for the project, else one
// compile of the inventory per call; each A1 change is in what it returns.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/client.ts";
import { call, connect, refusal, structured, text } from "../mcp/support.ts";
import { cleanUp, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const CONTEXT = `C4Context\nPerson(user, "Shopper")\nSystem(shop, "Web Shop")\nSystem_Ext(pay, "Payments", "Stripe")\nRel(user, shop, "buys")\nRel(shop, pay, "charges")\n`;
const FLOW = `flowchart LR\n  shop[Shop]:::system\n  ledger[(Ledger)]:::database\n  shop e1@--> ledger\n`;
const fence = (front: string, body: string): string =>
  `---\n${front}\n---\n# Checkout\n\n\`\`\`mermaid\n%% archer-id: flow\n${body}\`\`\`\n`;

function project(): string {
  const root = tempDir("archer-find-");
  write(root, "archer.toml", "version = 1\n");
  write(root, ".archer/diagrams/context.mmd", CONTEXT);
  write(root, ".archer/notes/checkout.md", fence("author: agent", FLOW));
  return root;
}
type Hit = { id: string; name: string; kinds: string[]; parents: string[]; drawnIn: string[]; matched: string };
const hits = (result: Awaited<ReturnType<typeof call>>): Hit[] => structured(result)["elements"] as Hit[];

test("offline: one line per hit, the full results in structured content, and the advice to reuse an id", async () => {
  const root = project();
  const { client, close } = await connect({ cwd: root });
  try {
    const found = await call(client, "find_elements", { query: "web shop" });
    expect(structured(found)).toMatchObject({ source: "offline", total: expect.any(Number) });
    expect(hits(found)[0]).toMatchObject({
      id: "shop",
      name: "Web Shop",
      kinds: ["system"],
      parents: [],
      drawnIn: ["context", "notes/checkout.md#flow"],
    });
    const lines = text(found).split("\n");
    expect(lines[0]).toMatch(/^shop — Web Shop \(system\) · in 2 diagrams$/);
    expect(text(found)).toMatch(/reuse a hit's id/i);
    const exact = await call(client, "find_elements", { id: "shop" });
    expect(structured(exact)["elements"]).toEqual([
      expect.objectContaining({
        id: "shop",
        relationships: expect.objectContaining({ out: 2, in: 1, list: expect.any(Array) }),
      }),
    ]);
    expect(hits(await call(client, "find_elements", { kind: "container" })).map((h) => h.id)).toEqual(["ledger"]);
    const readable = text(await call(client, "find_elements", { query: "web shop", outputFormat: "text" }));
    expect(readable.split("\n")[0]).toBe(lines[0]);
    expect(readable).toMatch(/outputFormat=json/);
  } finally {
    await close();
  }
});

test("refusals: query with id, an unknown diagram, a limit out of range", async () => {
  const root = project();
  const { client, close } = await connect({ cwd: root });
  try {
    expect((await refusal(client, "find_elements", { query: "shop", id: "shop" })).data["code"]).toBe(
      "invalid_arguments",
    );
    expect((await refusal(client, "find_elements", { diagram: "nowhere" })).data["code"]).toBe("diagram_not_found");
    expect((await refusal(client, "find_elements", { limit: 0 })).data["code"]).toBe("invalid_arguments");
    expect((await refusal(client, "find_elements", { limit: 51 })).data["code"]).toBe("invalid_arguments");
    expect((await refusal(client, "find_elements", { query: "x".repeat(201) })).data["code"]).toBe("invalid_arguments");
  } finally {
    await close();
  }
});

test("offline, a view that never compiled is named, since there is no last-good copy of it", async () => {
  const root = project();
  write(root, ".archer/diagrams/broken.mmd", "flowchart LR\n  a[A] --> b[B]\n");
  const { client, close } = await connect({ cwd: root });
  try {
    const found = await call(client, "find_elements", { query: "shop" });
    expect(structured(found)["notCompiled"]).toEqual(["broken"]);
    expect(text(found)).toMatch(/not searched.*broken/i);
  } finally {
    await close();
  }
});

test("an id drawn only in a proposed view is not found, and the result says where it is", async () => {
  const root = project();
  write(
    root,
    ".archer/notes/plan.md",
    `---\nstatus: proposed\n---\n# Plan\n\n\`\`\`mermaid\n%% archer-id: gift\nC4Context\nSystem(gift, "Gift Cards")\n\`\`\`\n`,
  );
  const { client, close } = await connect({ cwd: root });
  try {
    const found = await call(client, "find_elements", { id: "gift" });
    expect(structured(found)).toMatchObject({ total: 0, elements: [], proposedIn: ["notes/plan.md#gift"] });
    expect(text(found)).toMatch(/only in proposed/i);
  } finally {
    await close();
  }
});

test("with a service running for the project, it reads the service's model; each A1 change is in the result", async () => {
  const root = project();
  const { svc } = await service();
  const held = await connectService(svc.socketPath);
  try {
    await held.call("attach", { root });
  } finally {
    held.close();
  }
  const { client, close } = await connect({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: () => connectService(svc.socketPath),
  });
  const ids = async () => hits(await call(client, "find_elements", {})).map((h) => h.id);
  try {
    const first = await call(client, "find_elements", { query: "web shop" });
    expect(structured(first)["source"]).toBe("service");
    expect(await ids()).toEqual(["ledger", "pay", "shop", "user"]);
    // A good edit.
    write(root, ".archer/diagrams/context.mmd", CONTEXT.replace('"Web Shop"', '"Storefront"'));
    expect(hits(await call(client, "find_elements", { id: "shop" }))[0]!.name).toBe("Storefront");
    // A status-only edit, and back.
    write(root, ".archer/notes/checkout.md", fence("author: agent\nstatus: proposed", FLOW));
    expect(await ids()).toEqual(["pay", "shop", "user"]);
    // A based-on-only edit.
    write(root, ".archer/notes/checkout.md", fence("author: agent\nbased-on: context@sha256:00", FLOW));
    expect(await ids()).toEqual(["pay", "shop", "user"]);
    write(root, ".archer/notes/checkout.md", fence("author: agent", FLOW));
    expect(await ids()).toEqual(["ledger", "pay", "shop", "user"]);
    // Removing a good view.
    rmSync(join(root, ".archer/diagrams/context.mmd"));
    expect(await ids()).toEqual(["ledger", "shop"]);
  } finally {
    await close();
  }
});

test("a service that does not have the project attached is not attached for it: the call compiles offline", async () => {
  const root = project();
  const { svc } = await service();
  const { client, close } = await connect({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: () => connectService(svc.socketPath),
  });
  try {
    expect(structured(await call(client, "find_elements", { query: "shop" }))["source"]).toBe("offline");
    const held = await connectService(svc.socketPath);
    try {
      expect((await held.call("listProjects", {})).projects).toEqual([]);
    } finally {
      held.close();
    }
  } finally {
    await close();
  }
});
