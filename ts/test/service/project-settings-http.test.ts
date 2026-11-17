import { displayLocation } from "../../src/config/project-settings.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/index.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { cleanUp, FLOW, http, service, tempDir, write, apiBase, serviceBase } from "./support.ts";

afterEach(cleanUp);

const MANIFEST = [
  "# Demo project — comments stay",
  "version = 1",
  "name = 'Demo'   # shown on the Projects page",
  "",
  "[discovery]",
  'roots = [".archer", "docs"]',
  'exclude = ["docs/private/**"]',
  "",
  "[feedback]",
  'changes = "manual"',
  "",
  "[[views]]",
  'id = "flow"',
  'kind = "freeform"',
  'title = "The flow"',
  'source = ".archer/flow.mmd"',
  'covers = ["src/**"]',
  "",
].join("\n");

async function attached(manifest = MANIFEST) {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = tempDir("archer-proj-");
  write(root, "archer.toml", manifest);
  write(root, ".archer/flow.mmd", FLOW);
  // The attach URL is the clean page address; the project API lives at its resource base.
  const url = apiBase((await client.call("attach", { root })).url);
  const origin = `http://127.0.0.1:${svc.port}`;
  const settingsUrl = `${url}api/project-settings`;
  const patch = (body: unknown, headers: Record<string, string> = { origin, "content-type": "application/json" }) =>
    http(settingsUrl, { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { svc, client, root, url, origin, settingsUrl, patch, slug: url.split("/p/")[1]!.split("/")[0]! };
}

test("GET returns the settings snapshot with the manifest's exact text and byte revision", async () => {
  const { client, root, settingsUrl, slug } = await attached();
  const reply = await http(settingsUrl);
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body)).toEqual({
    schemaVersion: 1,
    slug,
    revision: revisionOf(Buffer.from(MANIFEST)),
    loaded: true,
    general: {
      name: "Demo",
      nameSource: "archer.toml",
      description: null,
      descriptionSource: null,
      location: displayLocation(root),
      folder: ".archer",
      editing: { enabled: true, source: "default" },
    },
    views: [{ id: "flow", kind: "freeform", title: "The flow", source: "flow.mmd", covers: ["src/**"] }],
    viewProblems: [],
    discovery: {
      roots: [".archer", "docs"],
      exclude: ["docs/private/**"],
      configured: { roots: [".archer", "docs"], exclude: ["docs/private/**"] },
    },
    feedback: {
      changes: "manual",
      delivery: "next_call",
      allowNotifications: false,
      notificationPolicy: "not_requested",
      sources: { changes: "project", delivery: "builtin", allowNotifications: "builtin" },
    },
    visibility: { state: "active", visibility: "auto" },
    manifest: { path: "archer.toml", text: MANIFEST },
  });
  client.close();
});

test("PATCH is refused for every request shape and never reads the body or touches archer.toml", async () => {
  const { client, root, settingsUrl, patch, origin } = await attached();
  const before = JSON.parse((await http(settingsUrl)).body) as { revision: string };
  const good = { revision: before.revision, changes: { name: "Renamed" } };
  for (const reply of [
    await patch(good),
    await patch(good, { "content-type": "application/json" }),
    await patch("not json"),
    await http(settingsUrl, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: " ".repeat(70 * 1024),
    }),
  ])
    expect([reply.status, JSON.parse(reply.body).error.code]).toEqual([403, "settings_read_only"]);
  expect(readFileSync(join(root, "archer.toml"), "utf8")).toBe(MANIFEST);
  client.close();
});

test("visibility comes from the lifecycle store and changes only through its own action", async () => {
  const { client, settingsUrl, svc, origin, slug, root } = await attached();
  const changed = await http(`${serviceBase(svc.homeUrl)}api/project-lifecycle`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ slug, action: "archive" }),
  });
  expect(changed.status, changed.body).toBe(200);
  const snapshot = JSON.parse((await http(settingsUrl)).body) as Record<string, unknown>;
  expect(snapshot["visibility"]).toEqual({ state: "inactive", visibility: "hidden", reason: "manual" });
  expect(readFileSync(join(root, "archer.toml"), "utf8")).toBe(MANIFEST);
  client.close();
});

test("a project running on defaults names its directory and has no manifest", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = tempDir("archer-proj-");
  write(root, ".git/HEAD", "ref: refs/heads/main\n");
  write(root, ".archer/flow.mmd", FLOW);
  // The attach URL is the clean page address; the project API lives at its resource base.
  const url = apiBase((await client.call("attach", { root })).url);
  const snapshot = JSON.parse((await http(`${url}api/project-settings`)).body) as Record<string, unknown>;
  expect(snapshot).toMatchObject({
    revision: null,
    loaded: true,
    manifest: null,
    general: { nameSource: "directory" },
  });
  expect(readdirSync(root)).not.toContain("archer.toml");
  client.close();
});
