// Asked "which Archer project is this?", a small agent read the page URL's folder slug
// ("project") as its name (docs/evaluations/eval-baseline.md, which-project). The calls an agent
// makes first now say the project's name: archer.toml's name, else its repository's, else its folder's.
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, project, service, tempDir, write } from "../service/support.ts";
import { join } from "node:path";

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await cleanUp();
});

function named(name: string) {
  const root = project();
  write(root, "archer.toml", `version = 1\nname = "${name}"\n`);
  return root;
}

test("list_diagrams names the project", async () => {
  const app = createApplication({ cwd: named("Pageturner") });
  apps.push(app);
  const listed = await app.call("list_diagrams", {});
  expect(listed.text).toMatch(/^Project "Pageturner": /);
  expect(listed.structured).toMatchObject({ project: { name: "Pageturner" } });
});

test("archer list names the project", async () => {
  const root = named("Pageturner");
  const state = tempDir();
  let out = "";
  const io: Io = {
    cwd: root,
    env: { ARCHER_STATE_DIR: state, ARCHER_SOCKET: join(state, "absent.sock") },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    isTTY: false,
    columns: undefined,
  };
  expect(await main(["list"], io)).toBe(0);
  expect(out).toContain("Project: Pageturner");
});

test("get_ui_url says whose page it is", async () => {
  const root = named("Pageturner");
  const { svc } = await service();
  const app = createApplication({ cwd: root, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const answer = await app.call("get_ui_url");
  expect(answer.text).toMatch(
    /^Archer page of project "Pageturner"; give this link exactly \(copy it, never retype it\):\nhttp\S+$/,
  );
  expect(answer.structured).toMatchObject({ project: { name: "Pageturner" } });
});
