import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createExportRuntime } from "./export-runtime";

describe("export browser runtime", () => {
  const runtimePromise = createExportRuntime();
  afterAll(async () => {
    await (await runtimePromise).close();
  });

  it("reuses one built runtime while isolating and cleaning service processes", async () => {
    const runtime = await runtimePromise;
    const first = await runtime.startProject({ gitHistory: false });
    const firstIdentity = first.runtimeIdentity;
    const firstPid = first.servicePid;
    const firstDirectory = first.dir;
    const firstSocket = first.socketPath;
    const firstUrl = first.url;
    await first.stop();
    expect(existsSync(firstDirectory)).toBe(false);
    expect(existsSync(firstSocket)).toBe(false);
    expect(() => process.kill(firstPid, 0)).toThrow();
    await expect(fetch(firstUrl)).rejects.toThrow();

    const second = await runtime.startProject({ gitHistory: false });
    expect(second.runtimeIdentity).toBe(firstIdentity);
    expect(second.servicePid).not.toBe(firstPid);
    expect(second.dir).not.toBe(firstDirectory);
    const secondDirectory = second.dir;
    await second.stop();
    expect(existsSync(secondDirectory)).toBe(false);

    const failed = await runtime.expectSetupFailureAfterServiceStart();
    expect(existsSync(failed.dir)).toBe(false);
    expect(existsSync(failed.socketPath)).toBe(false);
    expect(() => process.kill(failed.servicePid, 0)).toThrow();
  }, 45_000);

  it("ends the service when its parent lifetime channel closes", async () => {
    const runtime = await runtimePromise;
    const project = await runtime.startProject({ gitHistory: false });
    try {
      project.disconnectLifetime();
      expect(await project.waitForServiceExit()).toBe(true);
      expect(existsSync(project.socketPath)).toBe(false);
      expect(() => process.kill(project.servicePid, 0)).toThrow();
      await expect(fetch(project.url)).rejects.toThrow();
    } finally {
      await project.stop();
    }
  }, 15_000);
});
