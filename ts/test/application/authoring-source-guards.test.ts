import { readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { connectService, type ServiceClient } from "../../src/service/service-client.ts";
import { cleanUp, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);
const initial = "flowchart LR\r\n  a[Audit]\r\n";
const changed = initial.replace("[Audit]", "[Retained audit]");

test("standalone exact source preserves BOM and CRLF through an unchanged read/write", async () => {
  const cwd = tempDir();
  const exact = `\uFEFF${initial}`;
  const path = write(cwd, ".archer/policy.mmd", exact);
  const app = createApplication({ cwd });
  try {
    const before = await app.call("read_diagram", { viewId: "policy" });
    expect(before.structured.source).toMatchObject({ status: "text", text: exact });
    expect(before.structured.sourceRevision).toBe(revisionOf(Buffer.from(exact)));
    const answer = await app.call("write_diagram", {
      viewId: "policy",
      source: (before.structured.source as { text: string }).text,
      expectedRevision: before.structured.sourceRevision,
    });
    expect(answer.structured.status).toBe("unchanged");
    expect(readFileSync(path)).toEqual(Buffer.from(exact));
    expect(answer.structured.sourceRevision).toBe(before.structured.sourceRevision);
  } finally {
    app.close();
  }
});

// Delay only recordWrite on a real private service connection. All requests and
// replies retain the production protocol; the test controls the awaited window.
async function delayedAnnouncement() {
  const { svc } = await service();
  const actual = await connectService(svc.socketPath);
  let entered!: () => void;
  let release!: () => void;
  const announced = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: ServiceClient = {
    async call(method, params) {
      const answer = await actual.call(method, params);
      if (method === "recordWrite") {
        entered();
        await gate;
      }
      return answer;
    },
    close() {
      actual.close();
    },
  };
  return { client, announced, release };
}

for (const mutation of ["project root", "resolved authoring folder"] as const) {
  test(`standalone write refuses a byte-identical ${mutation} replacement during announcement`, async () => {
    const first = tempDir();
    const second = tempDir();
    write(first, "archer.toml", "version = 1\n");
    write(second, "archer.toml", "version = 1\n");
    const firstPath = write(first, ".archer/policy.mmd", initial);
    const secondPath = write(second, ".archer/policy.mmd", initial);
    const alias = join(tempDir(), "selected");
    symlinkSync(first, alias, "dir");
    const delay = await delayedAnnouncement();
    const app = createApplication({ cwd: alias, findService: async () => delay.client });
    try {
      const before = await app.call("read_diagram", { viewId: "policy" });
      const pending = app.call("write_diagram", {
        viewId: "policy",
        source: changed,
        expectedRevision: before.structured.sourceRevision,
      });
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await delay.announced;
      if (mutation === "project root") {
        rmSync(alias);
        symlinkSync(second, alias, "dir");
      } else {
        renameSync(join(first, ".archer"), join(first, "original"));
        symlinkSync(join(second, ".archer"), join(first, ".archer"), "dir");
      }
      delay.release();
      expect(await outcome).toMatchObject({ error: { data: { code: "revision_conflict" } } });
      expect(readFileSync(mutation === "project root" ? firstPath : join(first, "original/policy.mmd"), "utf8")).toBe(
        initial,
      );
      expect(readFileSync(secondPath, "utf8")).toBe(initial);
    } finally {
      delay.release();
      app.close();
    }
  });
}

for (const mutation of ["bytes", "removed", "source mapping", "authoring folder"] as const) {
  test(`standalone write refuses ${mutation} changed during awaited announcement`, async () => {
    const cwd = tempDir();
    const path = write(cwd, ".archer/policy.mmd", initial);
    const other = write(cwd, ".archer/other.mmd", initial);
    const alternate = write(cwd, "alternate/policy.mmd", initial);
    const manifest = (folder = ".archer", source = ".archer/policy.mmd") =>
      `version = 1\nfolder = "${folder}"\n[[views]]\nid = "policy"\nkind = "freeform"\ntitle = "Policy"\nsource = "${source}"\n`;
    write(cwd, "archer.toml", manifest());
    const delay = await delayedAnnouncement();
    const app = createApplication({ cwd, findService: async () => delay.client });
    try {
      const before = await app.call("read_diagram", { viewId: "policy" });
      const pending = app.call("write_diagram", {
        viewId: "policy",
        source: changed,
        expectedRevision: before.structured.sourceRevision,
      });
      // Attach rejection handling before releasing the deterministic window.
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await delay.announced;
      const external = initial.replace("[Audit]", "[External edit]");
      if (mutation === "bytes") write(cwd, ".archer/policy.mmd", external);
      if (mutation === "removed") rmSync(path);
      if (mutation === "source mapping") write(cwd, "archer.toml", manifest(".archer", ".archer/other.mmd"));
      if (mutation === "authoring folder") write(cwd, "archer.toml", manifest("alternate", "alternate/policy.mmd"));
      delay.release();
      expect(await outcome).toMatchObject({ error: { data: { code: "revision_conflict" } } });
      if (mutation === "removed") expect(() => readFileSync(path)).toThrow();
      else expect(readFileSync(path, "utf8")).toBe(mutation === "bytes" ? external : initial);
      expect(readFileSync(other, "utf8")).toBe(initial);
      expect(readFileSync(alternate, "utf8")).toBe(initial);
    } finally {
      delay.release();
      app.close();
    }
  });
}
