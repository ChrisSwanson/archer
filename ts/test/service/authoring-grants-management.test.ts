import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { parseRequest } from "../../src/service/socket.ts";
import { cleanUp, project, service, tempDir } from "./support.ts";

afterEach(cleanUp);

test("OS management issues a fresh scoped authoring entitlement without upgrading old browser grants", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    await client.call("attach", { root });
    const legacy = await client.call("issueAccess", { label: "Existing browser" });
    const before = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
    const issued = await client.call("issueAuthoringAccess", { label: "Editor", projectRoots: [root] });
    expect(issued.id).not.toBe(legacy.id);
    expect(issued.token).toMatch(/^[a-f0-9]{32}$/);
    expect(issued.url).toContain(`token=${issued.token}`);
    expect(issued.projectRoots).toEqual([root]);
    const after = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
    expect(after.version).toBe(1);
    expect(after.grants[0]).toEqual(before.grants[0]);
    expect(after.grants).toHaveLength(2);
    const entitlements = JSON.parse(readFileSync(join(state, "authoring-grants.json"), "utf8"));
    expect(entitlements).toEqual({
      version: 1,
      entitlements: [
        {
          entitlementId: issued.entitlementId,
          grantId: issued.id,
          projectRoots: [root],
          issuedAt: expect.any(String),
          revokedAt: null,
        },
      ],
    });
    expect(JSON.stringify(entitlements)).not.toContain(issued.token);
    expect(legacy).not.toHaveProperty("entitlementId");
  } finally {
    client.close();
  }
});

test("unattached projects refuse before issuing any ordinary grant", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const before = await client.call("listAccess", {});
    await expect(
      client.call("issueAuthoringAccess", { label: "Editor", projectRoots: [project()] }),
    ).rejects.toMatchObject({ error: { code: "project_not_attached" } });
    expect(await client.call("listAccess", {})).toEqual(before);
  } finally {
    client.close();
  }
});

test("entitlement persistence failure returns no token receipt and preserves old grant entries", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    await client.call("attach", { root });
    await client.call("issueAccess", { label: "Old browser" });
    const before = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
    const path = join(state, "authoring-grants.json");
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    await expect(client.call("issueAuthoringAccess", { label: "Editor", projectRoots: [root] })).rejects.toMatchObject({
      error: { code: "invalid_authoring_store" },
    });
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
    const after = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
    expect(after.grants[0]).toEqual(before.grants[0]);
    expect(after.grants).toHaveLength(2);
    // Corrupt construction is memoized for this service lifetime. Repairing the
    // file externally cannot silently recover authoring authority in this owner.
    writeFileSync(path, '{"version":1,"entitlements":[]}');
    await expect(client.call("issueAuthoringAccess", { label: "Retry", projectRoots: [root] })).rejects.toMatchObject({
      error: { code: "invalid_authoring_store" },
    });
    expect(readFileSync(path, "utf8")).toBe('{"version":1,"entitlements":[]}');
    expect((await client.call("listAccess", {})).grants[0]?.id).toBe(before.grants[0].id);
  } finally {
    client.close();
  }
});

test("management resolves input to attached canonical roots and rejects duplicate discovered roots", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  try {
    expect(existsSync(join(state, "authoring-grants.json"))).toBe(false);
    const root = project();
    await client.call("attach", { root });
    mkdirSync(join(root, "nested"));
    const issued = await client.call("issueAuthoringAccess", { label: "Editor", projectRoots: [join(root, "nested")] });
    expect(issued.projectRoots).toEqual([root]);
    const before = await client.call("listAccess", {});
    await expect(
      client.call("issueAuthoringAccess", { label: "Duplicate", projectRoots: [root, join(root, "nested")] }),
    ).rejects.toMatchObject({ error: { code: "invalid_params" } });
    expect(await client.call("listAccess", {})).toEqual(before);
  } finally {
    client.close();
  }
});

test("the new management method strictly bounds fields, labels and project root input", () => {
  const valid = { id: 1, method: "issueAuthoringAccess", params: { label: "Editor", projectRoots: ["/tmp/project"] } };
  expect(parseRequest(valid)).toEqual(valid);
  for (const params of [
    { ...valid.params, grantId: "existing" },
    { ...valid.params, label: "" },
    { ...valid.params, label: "x".repeat(129) },
    { ...valid.params, label: "a\nb" },
    { ...valid.params, projectRoots: [] },
    { ...valid.params, projectRoots: new Array(17).fill("/tmp/root") },
    { ...valid.params, projectRoots: [false] },
    { ...valid.params, projectRoots: ["a\0b"] },
    { ...valid.params, projectRoots: ["/" + "x".repeat(4096)] },
  ])
    expect(() => parseRequest({ ...valid, params })).toThrowError(expect.objectContaining({ code: "invalid_params" }));
  expect(() => parseRequest({ ...valid, unexpected: true })).toThrowError(
    expect.objectContaining({ code: "invalid_params" }),
  );
});

test("a corrupt authoring file cannot prevent legacy service startup or ordinary access issuance", async () => {
  const state = tempDir();
  const path = join(state, "authoring-grants.json");
  writeFileSync(path, "{corrupt", { mode: 0o600 });
  const { svc } = await service({ stateDir: state });
  const client = await connectService(svc.socketPath);
  try {
    const ordinary = await client.call("issueAccess", { label: "Ordinary browser" });
    expect(ordinary.token).toMatch(/^[a-f0-9]{32}$/);
    expect(ordinary).not.toHaveProperty("entitlementId");
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
    expect((await client.call("listAccess", {})).grants).toHaveLength(1);
  } finally {
    client.close();
  }
});
