/**
 * The shared service outlasts the account's remembered-project cap (`MAX_REMEMBERED_PROJECTS`, 256 in
 * `ts/src/state/account.ts`). The account remembers every root it ever attached and a detach does not forget one,
 * so a worker's 257th attach on one service used to fail with `saved_state_capacity`, in whichever test drew it.
 */
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const REMEMBERED = 256;

test("a worker's shared service attaches more projects than the account remembers", async () => {
  test.setTimeout(180_000);
  for (let n = 0; n <= REMEMBERED + 8; n++) {
    const project = await sharedTsProject({ files: { "archer.toml": "version = 1\n" } });
    try {
      // Only this test's project is attached, before and after the service is renewed.
      const { projects } = (await project.call("listProjects")) as { projects: { root: string }[] };
      expect(projects.map((p) => p.root)).toEqual([project.root]);
    } finally {
      await project.stop();
    }
  }
});
