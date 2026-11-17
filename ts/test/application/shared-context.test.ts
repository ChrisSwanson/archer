import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, project, service, write } from "../service/support.ts";

afterEach(cleanUp);

test("a fresh application reports the service presentation and last good model", async () => {
  const root = project();
  const { svc } = await service();
  const options = {
    cwd: root,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  };
  const first = createApplication(options);
  const presented = await first.call("present_diagram", { viewId: "flow", annotation: "Shared context" });
  first.close();
  const fresh = createApplication(options);
  try {
    expect((await fresh.call("get_presentation_context")).structured.presentation).toEqual(
      presented.structured.presentation,
    );
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Broken\n");
    const read = await fresh.call("read_diagram", { viewId: "flow" });
    expect(read.structured.compile).toMatchObject({ status: "failed" });
    expect(read.structured.envelope).toEqual(presented.structured.envelope);
    const again = await fresh.call("present_diagram", { viewId: "flow" });
    expect(again.structured.envelope).toEqual(presented.structured.envelope);
  } finally {
    fresh.close();
  }
});

test("offline authoring does not start a service for a missing last good model", async () => {
  const root = project();
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[Broken\n");
  let starts = 0;
  const app = createApplication({
    cwd: root,
    findService: async () => null,
    ensureService: async () => {
      starts++;
      throw new Error("must not start");
    },
  });
  try {
    expect((await app.call("read_diagram", { viewId: "flow" })).structured.envelope).toBeNull();
    expect(starts).toBe(0);
  } finally {
    app.close();
  }
});

test("an MCP read primes the running service so a fresh application retains the last valid model", async () => {
  const { connect, call, structured } = await import("../mcp/support.ts");
  const root = project();
  const { svc } = await service();
  let starts = 0;
  const options = {
    cwd: root,
    ensureService: async () => {
      starts++;
      return connectService(svc.socketPath);
    },
    findService: () => connectService(svc.socketPath),
  };
  const audit = await connectService(svc.socketPath);
  expect((await audit.call("listProjects", {})).projects).toEqual([]);
  audit.close();
  const first = await connect(options);
  const valid = structured(await call(first.client, "read_diagram", { viewId: "flow" }));
  await first.close();
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[Broken\n");
  const fresh = createApplication(options);
  try {
    const failed = await fresh.call("read_diagram", { viewId: "flow" });
    expect(failed.structured.compile).toMatchObject({ status: "failed" });
    expect(failed.structured.envelope).toEqual(valid.envelope);
    expect(starts).toBe(0);
  } finally {
    fresh.close();
  }
});
