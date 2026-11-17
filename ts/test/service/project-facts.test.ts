import { expect, test } from "vitest";
import { homeRelative, projectFacts } from "../../src/service/project-facts.ts";

const threads = (open: number, resolved: number) => ({ draft: 0, sent: open, read: 0, answered: 0, resolved });

test.each([
  ["/home/ada/code/archer", "/home/ada", "~/code/archer"],
  ["/home/ada", "/home/ada", "~"],
  ["/home/adam/code", "/home/ada", "\u2026/code"],
  ["/srv/project", "/home/ada", "\u2026/project"],
  ["/home/ada/code", "/home/ada/", "~/code"],
  ["/home/ada/code", "", "\u2026/code"],
])("homeRelative(%s, %s) is %s", (path, home, expected) => {
  expect(homeRelative(path, home)).toBe(expected);
});

test("facts count diagrams, notes and open threads, and take the latest edit", () => {
  const facts = projectFacts({
    views: [{ threads: threads(2, 5), modifiedAt: "2026-10-01T00:00:00.000Z" }, {}],
    notes: [
      { threads: { draft: 1, sent: 0, read: 1, answered: 1, resolved: 9 }, modifiedAt: "2026-10-17T08:00:00.000Z" },
      { modifiedAt: "2026-09-01T00:00:00.000Z" },
      {},
    ],
    root: "/home/ada/code/archer",
    home: "/home/ada",
    git: { branch: "main", commit: "a35b01b" },
  });
  expect(facts).toEqual({
    diagrams: 2,
    notes: 3,
    openThreads: 4,
    lastEditedAt: "2026-10-17T08:00:00.000Z",
    projectFolder: "~/code/archer",
    git: { branch: "main", commit: "a35b01b" },
  });
});

test("an unsent draft is not an open thread: the count matches what the agent sees", () => {
  const facts = projectFacts({
    views: [{ threads: { draft: 1, sent: 0, read: 0, answered: 0, resolved: 0 } }],
    notes: [{ threads: { draft: 2, sent: 1, read: 0, answered: 0, resolved: 3 } }],
    root: "/srv/p",
    home: "/home/ada",
    git: null,
  });
  expect(facts.openThreads).toBe(1);
});

test("an empty project outside Git has zero counts and no edit or Git fact", () => {
  const facts = projectFacts({ views: [], notes: [], root: "/srv/p", home: "/home/ada", git: null });
  expect(facts).toEqual({ diagrams: 0, notes: 0, openThreads: 0, projectFolder: "\u2026/p" });
  expect(projectFacts({ views: [], notes: [], root: "/srv/p", home: "/home/ada", git: undefined })).not.toHaveProperty(
    "git",
  );
});
