import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { connectService } from "../../src/service/client.ts";
import { isolatedProcessEnv, cleanUp, project, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);
function runner(root: string, env: Io["env"]) {
  return async (args: string[]) => {
    let out = "",
      err = "";
    const code = await main(["emphasis", ...args], {
      cwd: root,
      env,
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      isTTY: false,
      columns: undefined,
    });
    return { code, out, err };
  };
}
test("list is JSON, project-scoped and does not start an absent service", async () => {
  const root = project(),
    state = tempDir();
  const run = runner(root, { ARCHER_STATE_DIR: state, ARCHER_SOCKET: join(state, "none.sock") });
  const result = await run(["list", "flow", "--json"]);
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out)).toEqual({
    schemaVersion: 1,
    views: [{ schemaVersion: 1, viewId: "flow", emphases: [] }],
  });
  expect(existsSync(join(state, "archer.lock"))).toBe(false);
  expect((await run(["list", "unknown"])).code).toBe(1);
});
test("set/list/clear use production validation and current live emphasis", async () => {
  const root = project();
  const { svc } = await service();
  const run = runner(root, { ARCHER_SOCKET: svc.socketPath });
  write(
    root,
    "emphasis.json",
    JSON.stringify({ viewId: "flow", id: "demo", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }] }),
  );
  const set = await run(["set", "--file", "emphasis.json", "--json"]);
  expect(set.code, set.err).toBe(0);
  expect(JSON.parse(set.out).emphasis.groups[0]).toMatchObject({ state: "existing", nodes: ["a"], edges: [] });
  expect(JSON.parse((await run(["list", "flow"])).out).views[0].emphases[0].id).toBe("demo");
  write(
    root,
    "emphasis.json",
    JSON.stringify({
      viewId: "flow",
      id: "demo",
      groups: [{ id: "g", label: "g", style: "highlight", nodes: ["missing"] }],
    }),
  );
  const bad = await run(["set", "--file", "emphasis.json"]);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("missing");
  expect(JSON.parse((await run(["list", "flow"])).out).views[0].emphases[0].groups[0].nodes).toEqual(["a"]);
  expect((await run(["clear", "flow", "demo"])).code).toBe(0);
  expect(JSON.parse((await run(["list", "flow"])).out).views[0].emphases).toEqual([]);
});
test("CLI discovery reads emphasis created in the detached production service", { timeout: 30_000 }, async () => {
  const root = project(),
    state = tempDir();
  const env = isolatedProcessEnv(state, {
    ARCHER_FORCE_HTTP: "true",
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: join(state, "archer.sock"),
    XDG_RUNTIME_DIR: "",
  });
  const run = runner(root, env);
  const io: Io = { cwd: root, env, stdout: () => {}, stderr: () => {}, isTTY: false, columns: undefined };
  try {
    expect(await main(["serve"], io)).toBe(0);
    const client = await connectService(join(state, "archer.sock"));
    try {
      await client.call("setEmphasis", {
        root,
        viewId: "flow",
        emphases: [{ id: "outside", viewId: "flow", groups: [{ id: "g", label: "g", style: "flow", edges: ["e1"] }] }],
      });
    } finally {
      client.close();
    }
    expect(JSON.parse((await run(["list", "flow", "--json"])).out).views[0].emphases[0]).toMatchObject({
      id: "outside",
      groups: [{ style: "flow", speed: "normal", edges: ["e1"] }],
    });
  } finally {
    await main(["stop"], io);
  }
});
test.each(
  [[], ["unknown"], ["clear", "flow"], ["list", "a", "b"], ["set"], ["list", "--file", "x"]].map((args) => ({ args })),
)("CLI refuses malformed command $args", async ({ args }) => {
  expect((await runner(project(), {})(args)).code).toBe(2);
});
