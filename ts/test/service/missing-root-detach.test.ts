// A project whose root folder is gone (a deleted scratch worktree) is detached automatically and
// durably, and the service log says so; its private state is kept, as for any detach.
import { rmSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { cleanUp, project, service } from "./support.ts";

afterEach(cleanUp);

const until = async (check: () => Promise<boolean>, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 25));
  }
};

test("a root removed while the service runs is detached, logged, and not restored", async () => {
  const kept = project(),
    gone = project();
  const lines: string[] = [];
  const first = await service({ housekeepingMs: 50, log: (line) => lines.push(line) });
  const client = await connectService(first.svc.socketPath);
  try {
    await client.call("attach", { root: kept });
    await client.call("attach", { root: gone });
    rmSync(gone, { recursive: true, force: true });
    await until(async () => (await client.call("listProjects", {})).projects.length === 1);
    expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([kept]);
    expect(lines.some((line) => line.includes(`detached ${gone}: its folder is gone`))).toBe(true);
  } finally {
    client.close();
  }
  await first.svc.close();
  expect(new AccountStateStore(first.state).attachedRoots()).toEqual([kept]);
});

test("a saved attachment whose root is gone at start is detached durably, not retried on every start", async () => {
  const kept = project(),
    gone = project();
  const first = await service();
  const setup = await connectService(first.svc.socketPath);
  await setup.call("attach", { root: kept });
  await setup.call("attach", { root: gone });
  setup.close();
  await first.svc.close();
  rmSync(gone, { recursive: true, force: true });
  const lines: string[] = [];
  const second = await service({ stateDir: first.state, log: (line) => lines.push(line) });
  const client = await connectService(second.svc.socketPath);
  try {
    expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([kept]);
  } finally {
    client.close();
  }
  await second.svc.close();
  expect(lines.some((line) => line.includes(`detached ${gone}: its folder is gone`))).toBe(true);
  expect(new AccountStateStore(first.state).attachedRoots()).toEqual([kept]);
});
