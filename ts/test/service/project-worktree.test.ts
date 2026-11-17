// A project without archer.toml's `name` is named after its git repository; a linked worktree
// is listed under the main repository's name with its folder and branch as a detail.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { ProjectNameStore } from "../../src/state/project-names.ts";
import { cleanUp, json, service, tempDir, write, serviceBase } from "./support.ts";

afterEach(cleanUp);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** `pageturner`, a repository with a note and no archer.toml, and its worktree `order-notes` elsewhere. */
function finWithWorktree(): { main: string; worktree: string } {
  const main = join(tempDir(), "pageturner");
  mkdirSync(main);
  write(main, ".archer/notes/a.md", "# A\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "one");
  const worktree = join(tempDir(), "scratchpad", "order-notes");
  git(main, "worktree", "add", "-q", "-b", "demo/order-notes", worktree);
  return { main, worktree };
}

test("a worktree is listed as the repository's project, with its folder and branch, at <repository>-<folder>", async () => {
  const { main, worktree } = finWithWorktree();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const app = await client.call("attach", { root: main });
    const tree = await client.call("attach", { root: worktree });
    expect(app).toMatchObject({
      name: "pageturner",
      repository: { name: "pageturner", commonDir: join(main, ".git") },
    });
    expect(app.repository?.worktree).toBeUndefined();
    expect(tree).toMatchObject({
      name: "pageturner",
      repository: {
        name: "pageturner",
        commonDir: join(main, ".git"),
        worktree: { folder: "order-notes", branch: "demo/order-notes" },
      },
    });
    expect(new URL(app.url).pathname).toBe("/projects/pageturner/");
    expect(new URL(tree.url).pathname).toBe("/projects/pageturner-order-notes/");
    expect(
      (await client.call("listProjects", {})).projects.map((p) => [p.name, p.repository?.worktree?.folder]),
    ).toEqual([
      ["pageturner", undefined],
      ["pageturner", "order-notes"],
    ]);
    const catalog = (await json(`${serviceBase(svc.homeUrl)}api/projects`)) as {
      projects: { slug: string; name: string; worktree?: unknown }[];
    };
    expect(catalog.projects.map((p) => [p.slug, p.name, p.worktree])).toEqual([
      ["pageturner", "pageturner", undefined],
      ["pageturner-order-notes", "pageturner", { folder: "order-notes", branch: "demo/order-notes" }],
    ]);
  } finally {
    client.close();
  }
});

test("a worktree registered before keeps its page address and is now called by the repository's name", async () => {
  const { worktree } = finWithWorktree();
  const state = tempDir("archer-state-");
  // As an older service recorded it: the folder's name.
  expect(new ProjectNameStore(state).nameFor(worktree)).toBe("order-notes");
  const { svc } = await service({ stateDir: state });
  const client = await connectService(svc.socketPath);
  try {
    const tree = await client.call("attach", { root: worktree });
    expect(new URL(tree.url).pathname).toBe("/projects/order-notes/");
    expect(tree.name).toBe("pageturner");
  } finally {
    client.close();
  }
});

test("a worktree's branch is current after a checkout, without detaching", async () => {
  const { worktree } = finWithWorktree();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    expect((await client.call("attach", { root: worktree })).repository?.worktree?.branch).toBe("demo/order-notes");
    git(worktree, "checkout", "-q", "-b", "demo/order-notes-v2");
    await new Promise((done) => setTimeout(done, 1_100));
    expect((await client.call("listProjects", {})).projects[0]?.repository?.worktree?.branch).toBe(
      "demo/order-notes-v2",
    );
  } finally {
    client.close();
  }
});
