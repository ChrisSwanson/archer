import { expect, test } from "vitest";
import type { GlobalConfig, ProjectRule } from "../../src/config/index.ts";
import { ProjectError } from "../../src/project/errors.ts";
import { projectPatternMatches, resolveServiceConfiguration, selectProjectRule } from "../../src/config/resolve.ts";

test.each([
  ["/repo/*", "/repo/one", true],
  ["/repo/*", "/repo/one/two", false],
  ["/repo/**", "/repo", true],
  ["/repo/**", "/repo/one/two", true],
  ["/**/src/*", "/repo/src/a", true],
  ["/**/src/*", "/repo/src/a/b", false],
  ["/repo/**/src/*", "/repo/src/a", true],
  ["/repo/😀/**", "/repo/😀/src", true],
] as const)("matches %s against %s = %s", (pattern, path, expected) =>
  expect(projectPatternMatches(pattern, path)).toBe(expected),
);

test("a whole-segment ** specific rule beats a broad rule when it matches zero directories", () => {
  expect(
    selectProjectRule("/repo/src/a", [
      { path: "/repo/**", service: "broad" },
      { path: "/repo/**/src/*", service: "specific" },
    ])?.service,
  ).toBe("specific");
});

test("exact rules beat globs, literal specificity wins, and later ties win", () => {
  const rules: ProjectRule[] = [
    { path: "/work/**", service: "broad" },
    { path: "/work/proj*", service: "specific-old" },
    { path: "/work/proj*", service: "specific-new" },
    { path: "/work/project", service: "exact-old" },
    { path: "/work/project", service: "exact-new" },
  ];
  expect(selectProjectRule("/work/project", rules)?.service).toBe("exact-new");
  expect(selectProjectRule("/work/project-two", rules)?.service).toBe("specific-new");
});

test("user project lists replace system lists, including an empty list, and winning fields never merge", () => {
  const system: GlobalConfig = {
    version: 1,
    projects: [{ path: "/work/**", service: "system", readOnly: true, notes: false }],
  };
  const user: GlobalConfig = { version: 1, projects: [{ path: "/work/project", service: "user" }] };
  expect(
    resolveServiceConfiguration({ projectRoot: "/work/project", system, user, env: { HOME: "/h" } }).projectRule,
  ).toEqual({ path: "/work/project", service: "user" });
  expect(
    resolveServiceConfiguration({
      projectRoot: "/work/project",
      system,
      user: { version: 1, projects: [] },
      env: { HOME: "/h" },
    }),
  ).toMatchObject({ serviceName: "default" });
  expect(
    resolveServiceConfiguration({
      projectRoot: "/work/project",
      system,
      user: { version: 1, projects: [] },
      env: { HOME: "/h" },
    }).projectRule,
  ).toBeUndefined();
});

test("exact selection runs before the aggregate glob-work ceiling", () => {
  const root = `/${"a".repeat(4094)}`;
  const expensive = Array.from({ length: 4 }, (_, index) => ({
    path: `/${"a".repeat(4092)}${index}*`,
    service: `glob-${index}`,
  }));
  expect(selectProjectRule(root, [...expensive, { path: root, service: "exact" }])?.service).toBe("exact");
});

test("aggregate glob matching work is refused by name instead of skipping rules", () => {
  const root = `/${"a".repeat(4094)}`;
  const rules = Array.from({ length: 4 }, (_, index) => ({
    path: `/${"a".repeat(4092)}${index}*`,
    service: `glob-${index}`,
  }));
  let caught: unknown;
  try {
    selectProjectRule(root, rules);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectError);
  expect((caught as ProjectError).code).toBe("manifest_error");
  expect((caught as Error).message).toMatch(/64000000 cell work limit/);
});

test("matching strings over 4096 UTF-8 bytes are refused", () => {
  expect(() => projectPatternMatches(`/${"x".repeat(4096)}`, "/x")).toThrow(/4096 UTF-8 bytes/);
  expect(() => projectPatternMatches("/**", `/${"x".repeat(4096)}`)).toThrow(/4096 UTF-8 bytes/);
});
