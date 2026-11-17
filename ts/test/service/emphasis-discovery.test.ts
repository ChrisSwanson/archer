import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/client.ts";
import { parseRequest } from "../../src/service/socket.ts";
import { cleanUp, project, service } from "./support.ts";
afterEach(cleanUp);
test("management discovery serves current full and filtered snapshots; malformed/unknown views refuse", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root });
    const full = await client.call("listEmphases", { root });
    expect(full.schemaVersion).toBe(1);
    expect(full.views.map((v) => v.viewId)).toEqual(["flow", "chat"]);
    expect(full.views.every((v) => v.emphases.length === 0)).toBe(true);
    expect(await client.call("listEmphases", { root, viewId: "flow" })).toEqual({
      schemaVersion: 1,
      views: [{ schemaVersion: 1, viewId: "flow", emphases: [] }],
    });
    await expect(client.call("listEmphases", { root, viewId: "missing" })).rejects.toMatchObject({
      error: { code: "diagram_not_found" },
    });
    await expect(client.call("listEmphases", { root, viewId: "bad id" })).rejects.toMatchObject({
      error: { code: "invalid_params" },
    });
  } finally {
    client.close();
  }
});
test.each(["", null, 1, [], {}])("wire optional viewId refuses %j", (viewId) => {
  expect(() => parseRequest({ id: 1, method: "listEmphases", params: { root: "/project", viewId } })).toThrow(/viewId/);
});
test("wire recognizes valid optional view argument", () => {
  for (const params of [{ root: "/project" }, { root: "/project", viewId: "flow" }])
    expect(parseRequest({ id: 1, method: "listEmphases", params })).toMatchObject({ method: "listEmphases", params });
});
