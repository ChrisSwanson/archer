import { afterEach, expect, test, vi } from "vitest";
import { request } from "node:http";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, project, http, slugOf } from "./support.ts";

const fault = vi.hoisted(() => ({ directorySync: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (fault.directorySync && actual.fstatSync(fd).isDirectory()) {
        fault.directorySync = false;
        throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
      }
      actual.fsyncSync(fd);
    },
  };
});
afterEach(async () => {
  fault.directorySync = false;
  await cleanUp();
});

test("a revocation whose rename succeeds but directory sync fails still ends that grant's streams", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  let req: ReturnType<typeof request> | undefined;
  try {
    const attached = await client.call("attach", { root: project() });
    const grant = await client.call("issueAccess", { label: "Browser" });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      req = request(
        `${origin}/p/${slug}/api/events`,
        { headers: { authorization: `Bearer ${grant.token}` } },
        (res) => {
          res.resume();
          resolve(res);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(response.statusCode).toBe(200);
    fault.directorySync = true;
    await expect(client.call("revokeAccess", { grantId: grant.id })).rejects.toThrow("injected directory sync failure");
    expect((await http(`${origin}/api/projects`, { headers: { authorization: `Bearer ${grant.token}` } })).status).toBe(
      404,
    );
    await expect.poll(() => response.complete, { timeout: 1000 }).toBe(true);
  } finally {
    req?.destroy();
    client.close();
  }
}, 15_000);
