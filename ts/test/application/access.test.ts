import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService, ServiceUnavailableError, type ServiceClient } from "../../src/service/service-client.ts";
import { cleanUp, service, tempDir } from "../service/support.ts";
afterEach(cleanUp);
test("shared CLI/MCP application issues lists and revokes grants without project discovery", async () => {
  const { svc } = await service();
  const app = createApplication({ cwd: tempDir(), findService: () => connectService(svc.socketPath) });
  try {
    const issued = await app.call("issue_access_link", { label: "Interactive testing" });
    expect(issued.structured).toMatchObject({
      label: "Interactive testing",
      token: expect.stringMatching(/^[a-f0-9]{32}$/),
      url: expect.stringContaining("/projects/?token="),
    });
    const listed = await app.call("list_access_links", {});
    expect(JSON.stringify(listed)).not.toContain(String(issued.structured["token"]));
    expect(listed.structured).toMatchObject({ grants: [expect.objectContaining({ id: issued.structured["id"] })] });
    expect((await app.call("revoke_access_link", { grantId: issued.structured["id"] })).structured).toEqual({
      revoked: true,
    });
  } finally {
    app.close();
  }
}, 15_000);

test("an uncertain issued-link response is never replayed", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  let issued = 0,
    acquired = 0;
  const uncertain: ServiceClient = {
    call: async (method, params) => {
      const result = await client.call(method, params);
      if (method === "issueAccess") {
        issued++;
        throw new ServiceUnavailableError("response lost after persistence");
      }
      return result;
    },
    close: () => client.close(),
  };
  const app = createApplication({
    cwd: tempDir(),
    findService: async () => {
      acquired++;
      return uncertain;
    },
  });
  try {
    await expect(app.call("issue_access_link", { label: "Browser" })).rejects.toThrow("response lost");
    expect(issued).toBe(1);
    expect(acquired).toBe(1);
    const observer = await connectService(svc.socketPath);
    try {
      expect((await observer.call("listAccess", {})).grants).toHaveLength(1);
    } finally {
      observer.close();
    }
  } finally {
    app.close();
  }
}, 15_000);
