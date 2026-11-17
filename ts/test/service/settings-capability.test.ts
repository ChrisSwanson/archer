import { afterEach, expect, test } from "vitest";
import { cleanUp, http, service, serviceBase } from "./support.ts";

afterEach(async () => {
  await cleanUp();
});

test("service-scope metadata advertises instance settings with no attached projects", async () => {
  const { svc } = await service();

  const connection = await http(`${serviceBase(svc.homeUrl)}api/connection`);
  expect(connection.status).toBe(200);
  expect(JSON.parse(connection.body)).toMatchObject({
    browserProtocolMajor: 1,
    capabilities: expect.arrayContaining(["instance-settings"]),
  });

  const settings = await http(`${serviceBase(svc.homeUrl)}api/settings`);
  expect(settings.status).toBe(200);
  expect(JSON.parse(settings.body)).toMatchObject({
    serviceName: expect.any(String),
    configRevision: expect.stringMatching(/^sha256:/u),
  });
});
