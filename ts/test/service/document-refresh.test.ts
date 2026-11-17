import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { connectService } from "../../src/service/service-client.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { apiBase, cleanUp, events, http, service, tempDir, write } from "./support.ts";
afterEach(cleanUp);
test("real SSE announces create, body edit and delete for globally configured external documents", async () => {
  const stateDir = tempDir(),
    root = tempDir(),
    config = join(stateDir, "archer.toml");
  writeFileSync(config, 'version=1\n[discovery]\nroots=["docs"]\nexclude=["docs/excluded/**"]\n', { mode: 0o600 });
  write(root, ".archer/legacy.md", "# Legacy");
  write(root, "docs/seed.md", "# Seed");
  write(root, "docs/excluded/hidden.md", "# Excluded");
  const { svc } = await service({ stateDir, env: { ARCHER_CONFIG: config, ARCHER_OPEN_BROWSER: "never" } }),
    client = await connectService(svc.socketPath);
  let stream;
  try {
    const attached = await client.call("attach", { root });
    stream = await events(apiBase(attached.url) + "api/events");
    const next = () => stream!.next("documents", 2000);
    const created = next();
    write(root, "docs/new.md", "# New\n\nFirst body.");
    await created;
    const first = JSON.parse((await http(apiBase(attached.url) + "api/documents")).body);
    const entry = (value: { documents: { source: { path: string }; revision: string }[] }) =>
      value.documents.find((document) => document.source.path === "docs/new.md");
    expect(entry(first)?.revision).toMatch(/^sha256:/);
    expect(
      first.documents.some((document: { source: { path: string } }) => document.source.path.includes("excluded")),
    ).toBe(false);
    const edited = next();
    write(root, "docs/new.md", "# New\n\nChanged body only.");
    await edited;
    const second = JSON.parse((await http(apiBase(attached.url) + "api/documents")).body);
    expect(entry(second)?.revision).not.toBe(entry(first)?.revision);
    const deleted = next();
    unlinkSync(join(root, "docs/new.md"));
    await deleted;
    const third = JSON.parse((await http(apiBase(attached.url) + "api/documents")).body);
    expect(entry(third)).toBeUndefined();
  } finally {
    stream?.close();
    client.close();
  }
}, 15_000);

test("unchanged and excluded content never changes the configured catalog signature", async () => {
  const root = tempDir();
  write(root, "archer.toml", 'version=1\n[discovery]\nroots=["docs"]\nexclude=["docs/excluded/**"]\n');
  write(root, "docs/a.md", "# A");
  write(root, "docs/excluded/hidden.md", "# Hidden");
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`),
    received: string[] = [];
  const unsubscribe = state.subscribe((event) => received.push(event));
  try {
    await state.reload();
    expect(received).not.toContain("documents");
    write(root, "docs/excluded/hidden.md", "# Changed hidden");
    await state.reload();
    expect(received).not.toContain("documents");
    write(root, "docs/a.md", "# A\n\nChanged body");
    await state.reload();
    expect(received.filter((event) => event === "documents")).toHaveLength(1);
  } finally {
    unsubscribe();
    state.close();
  }
});
