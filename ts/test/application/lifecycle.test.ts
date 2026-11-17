import { afterEach, expect, test } from "vitest";
import { createApplication, OperationError } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, project, service } from "../service/support.ts";

afterEach(cleanUp);

test("parallel application calls share an owned service connection and close it once", async () => {
  const { svc } = await service();
  const acquired: { closed: number }[] = [];
  const app = createApplication({
    cwd: project(),
    ensureService: async () => {
      const entry = { closed: 0 };
      acquired.push(entry);
      const client = await connectService(svc.socketPath);
      const close = client.close.bind(client);
      client.close = () => {
        entry.closed++;
        close();
      };
      return client;
    },
  });
  try {
    const results = await Promise.all([app.call("get_ui_url"), app.call("get_ui_url")]);
    expect(results[0]?.structured).toEqual(results[1]?.structured);
    app.close();
    expect(acquired).toEqual([{ closed: 1 }]);
    app.close();
    expect(acquired).toEqual([{ closed: 1 }]);
  } finally {
    app.close();
  }
});

test("closing during pending acquisition closes the late client and refuses future calls", async () => {
  const { svc } = await service();
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = 0;
  const app = createApplication({
    cwd: project(),
    ensureService: async () => {
      const client = await connectService(svc.socketPath);
      const close = client.close.bind(client);
      client.close = () => {
        closed++;
        close();
      };
      signalStarted();
      await gate;
      return client;
    },
  });
  const pending = app.call("get_ui_url");
  const settled = pending.then(
    (answer) => ({ answer }),
    (error) => ({ error }),
  );
  await started;
  app.close();
  release();
  const result = await settled;
  expect(closed).toBe(1);
  expect(result).toHaveProperty("error");
  expect((result as { error: unknown }).error).toBeInstanceOf(OperationError);
  await expect(app.call("list_diagrams")).rejects.toMatchObject({ data: { code: "invalid_request" } });
});
