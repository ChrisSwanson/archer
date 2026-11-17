import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, project, service } from "../service/support.ts";

afterEach(cleanUp);

test("public registry runs list/read/resolve through one real service without autostart", async () => {
  const { svc } = await service();
  const admin = await connectService(svc.socketPath);
  const root = project();
  await admin.call("attach", { root });
  let starts = 0;
  const app = createApplication({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: async () => {
      starts++;
      return connectService(svc.socketPath);
    },
  });
  try {
    const record = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "draft", id: "from-editor" },
      eventKind: "draft.saved",
      before: null,
      after: Buffer.from("\uFEFFsaved\r\n"),
    }).record;
    expect((await app.call("list_changes", {})).structured.records).toEqual([
      expect.objectContaining({ changeId: record.changeId }),
    ]);
    expect(
      (await app.call("read_change", { changeId: record.changeId, part: "after" })).structured.source,
    ).toMatchObject({ text: "\uFEFFsaved\r\n", complete: true });
    expect(
      (
        await app.call("resolve_change", {
          changeId: record.changeId,
          expectedReviewRevision: 1,
          disposition: "handled",
        })
      ).structured.record,
    ).toMatchObject({ disposition: "handled", reviewRevision: 2 });
    await expect(
      app.call("resolve_change", { changeId: record.changeId, expectedReviewRevision: 1, disposition: "declined" }),
    ).rejects.toMatchObject({ data: { code: "change_review_conflict" } });
    await expect(app.call("read_change", { changeId: record.changeId, projectRoot: root })).rejects.toMatchObject({
      data: { code: "invalid_arguments" },
    });
    await expect(
      app.call("resolve_change", { changeId: record.changeId, expectedReviewRevision: 2, disposition: "withdrawn" }),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    expect(starts).toBe(0);
  } finally {
    app.close();
    admin.close();
  }
});

test("explicit authoring operation mints a fresh project-scoped token and preserves old grants", async () => {
  const { svc, state } = await service();
  const admin = await connectService(svc.socketPath);
  const root = project();
  await admin.call("attach", { root });
  const old = await admin.call("issueAccess", { label: "Ordinary" });
  const before = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
  let starts = 0;
  const app = createApplication({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: async () => {
      starts++;
      return connectService(svc.socketPath);
    },
  });
  try {
    const issued = await app.call("issue_authoring_access", { label: "Editor", projectRoots: [root] });
    expect(issued.structured.id).not.toBe(old.id);
    expect(issued.structured.token).not.toBe(old.token);
    expect(issued.structured.projectRoots).toEqual([root]);
    expect(issued.text).toContain(String(issued.structured.url));
    const after = JSON.parse(readFileSync(join(state, "access-grants.json"), "utf8"));
    expect(after.grants[0]).toEqual(before.grants[0]);
    const entitlements = JSON.parse(readFileSync(join(state, "authoring-grants.json"), "utf8"));
    expect(entitlements.entitlements).toEqual([
      expect.objectContaining({ grantId: issued.structured.id, projectRoots: [root] }),
    ]);
    for (const projectRoots of [[root, root], [`${root}/.archer`], ["relative"], [`${root}/../other`]])
      await expect(app.call("issue_authoring_access", { label: "No elevation", projectRoots })).rejects.toMatchObject({
        data: { code: "invalid_arguments" },
      });
    await expect(
      app.call("issue_authoring_access", { label: "No upgrade", projectRoots: [root], grantId: old.id }),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    expect((await admin.call("listAccess", {})).grants).toHaveLength(2);
    expect(starts).toBe(0);
  } finally {
    app.close();
    admin.close();
  }
});

test("explicit authoring issuance never starts an absent service or retries a lost connection", async () => {
  const root = project();
  let starts = 0,
    finds = 0;
  const app = createApplication({
    cwd: root,
    findService: async () => {
      finds++;
      return null;
    },
    ensureService: async () => {
      starts++;
      throw new Error("must not start");
    },
  });
  try {
    await expect(app.call("issue_authoring_access", { label: "Editor", projectRoots: [root] })).rejects.toMatchObject({
      data: { code: "io_failure" },
    });
    expect(starts).toBe(0);
    expect(finds).toBe(1);
  } finally {
    app.close();
  }
  const { svc } = await service();
  const closed = await connectService(svc.socketPath);
  closed.close();
  finds = 0;
  const lost = createApplication({
    cwd: root,
    findService: async () => {
      finds++;
      return closed;
    },
  });
  try {
    await expect(lost.call("issue_authoring_access", { label: "Editor", projectRoots: [root] })).rejects.toMatchObject({
      data: { code: "io_failure" },
    });
    expect(finds).toBe(1);
  } finally {
    lost.close();
  }
});

test("issue_access_link carries authoring through the same fail-closed management path only when asked", async () => {
  const { svc, state } = await service();
  const admin = await connectService(svc.socketPath);
  const root = project();
  await admin.call("attach", { root });
  const app = createApplication({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: async () => {
      throw new Error("must not start");
    },
  });
  const entitlements = () => {
    try {
      return JSON.parse(readFileSync(join(state, "authoring-grants.json"), "utf8")).entitlements;
    } catch {
      return [];
    }
  };
  try {
    const plain = await app.call("issue_access_link", { label: "Reader" });
    expect(plain.structured).not.toHaveProperty("entitlementId");
    expect(entitlements()).toEqual([]);
    const both = await app.call("issue_access_link", { label: "Reader and editor", authoringProjectRoots: [root] });
    expect(both.structured).toMatchObject({ projectRoots: [root], entitlementId: expect.any(String) });
    expect(both.text).toContain(String(both.structured.url));
    expect(entitlements()).toEqual([expect.objectContaining({ grantId: both.structured.id, projectRoots: [root] })]);
    for (const authoringProjectRoots of [[], [root, root], [`${root}/.archer`], ["relative"]])
      await expect(app.call("issue_access_link", { label: "Bad", authoringProjectRoots })).rejects.toMatchObject({
        data: { code: "invalid_arguments" },
      });
    await expect(
      app.call("issue_access_link", { label: "Detached", authoringProjectRoots: [project()] }),
    ).rejects.toMatchObject({ data: { code: "project_not_attached" } });
  } finally {
    app.close();
    admin.close();
  }
});

test("issue_access_link with authoring returns no token when the entitlement store fails", async () => {
  const { svc, state } = await service();
  const admin = await connectService(svc.socketPath);
  const root = project();
  await admin.call("attach", { root });
  writeFileSync(join(state, "authoring-grants.json"), "{corrupt", { mode: 0o600 });
  const app = createApplication({ cwd: root, findService: () => connectService(svc.socketPath) });
  try {
    const failed = app.call("issue_access_link", { label: "Editor", authoringProjectRoots: [root] });
    // The tool layer reports the service's invalid_authoring_store as an internal refusal.
    await expect(failed).rejects.toMatchObject({ message: expect.stringMatching(/authoring entitlement/u) });
    await failed.catch((error: unknown) => expect(JSON.stringify(error)).not.toMatch(/token/iu));
    expect(readFileSync(join(state, "authoring-grants.json"), "utf8")).toBe("{corrupt");
  } finally {
    app.close();
    admin.close();
  }
});
