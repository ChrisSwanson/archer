import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/mcp/index.ts";
import { cleanUp, service, project, write } from "../service/support.ts";
import { connect, call, structured, refusal } from "./support.ts";
afterEach(cleanUp);
test("advertises discovery and recovers normalized emphasis from a real service in a fresh adapter", async () => {
  const root = project();
  const { svc } = await service();
  const options = {
    cwd: root,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  };
  const first = await connect(options);
  expect((await first.client.listTools()).tools.map((t) => t.name)).toContain("list_emphases");
  await call(first.client, "set_emphasis", {
    viewId: "flow",
    id: "payment",
    title: "Payment",
    groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }],
  });
  await first.close();
  const fresh = await connect(options);
  try {
    expect(structured(await call(fresh.client, "list_emphases", { viewId: "flow" }))).toEqual({
      schemaVersion: 1,
      views: [
        {
          schemaVersion: 1,
          viewId: "flow",
          emphases: [
            {
              viewId: "flow",
              id: "payment",
              title: "Payment",
              groups: [
                {
                  id: "g",
                  label: "g",
                  style: "highlight",
                  palette: "teal",
                  state: "existing",
                  nodes: ["a"],
                  edges: [],
                },
              ],
            },
          ],
        },
      ],
    });
  } finally {
    await fresh.close();
  }
});

test("offline discovery includes every registered view and never starts a service", async () => {
  const root = project();
  let starts = 0;
  const connected = await connect({
    cwd: root,
    findService: async () => null,
    ensureService: async () => {
      starts++;
      throw new Error("must not start");
    },
  });
  try {
    const result = structured(await call(connected.client, "list_emphases"));
    expect(result).toEqual({
      schemaVersion: 1,
      views: [
        { schemaVersion: 1, viewId: "flow", emphases: [] },
        { schemaVersion: 1, viewId: "chat", emphases: [] },
      ],
    });
    expect(starts).toBe(0);
    expect((await refusal(connected.client, "list_emphases", { viewId: "absent" })).data.code).toBe(
      "diagram_not_found",
    );
    expect((await refusal(connected.client, "list_emphases", { viewId: "bad id" })).data.code).toBe(
      "invalid_arguments",
    );
  } finally {
    await connected.close();
  }
});

test("real service snapshot isolates roots and reflects replacement, clear and recompile", async () => {
  const root = project();
  const other = project();
  const { svc } = await service();
  const options = {
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  };
  const a = await connect({ ...options, cwd: root });
  const b = await connect({ ...options, cwd: other });
  const snapshot = async () =>
    structured(await call(a.client, "list_emphases", { viewId: "flow" })) as {
      views: { emphases: { id: string; groups: { nodes: string[] }[] }[] }[];
    };
  try {
    await call(a.client, "set_emphasis", {
      viewId: "flow",
      id: "one",
      groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a", "b"] }],
    });
    await call(b.client, "set_emphasis", {
      viewId: "flow",
      id: "other",
      groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }],
    });
    expect((await snapshot()).views[0]?.emphases.map((e) => e.id)).toEqual(["one"]);
    await call(a.client, "set_emphasis", {
      viewId: "flow",
      id: "one",
      groups: [{ id: "g", label: "g", style: "highlight", nodes: ["b"] }],
    });
    expect((await snapshot()).views[0]?.emphases[0]?.groups[0]?.nodes).toEqual(["b"]);
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client]\n");
    await expect.poll(async () => (await snapshot()).views[0]?.emphases).toEqual([]);
    expect(
      (
        structured(await call(b.client, "list_emphases", { viewId: "flow" })) as {
          views: { emphases: { id: string }[] }[];
        }
      ).views[0]?.emphases[0]?.id,
    ).toBe("other");
    await call(b.client, "set_emphasis", { viewId: "flow", id: "other", groups: [] });
    expect(structured(await call(b.client, "list_emphases", { viewId: "flow" }))).toEqual({
      schemaVersion: 1,
      views: [{ schemaVersion: 1, viewId: "flow", emphases: [] }],
    });
  } finally {
    await a.close();
    await b.close();
  }
});
