import { expect, test, vi } from "vitest";
import {
  forgetProjectCatalogs,
  markProjectCatalogStale,
  loadProjectCatalog,
  parseProjectCatalog,
  parseProjectCatalogEntries,
  rememberedProjectCatalog,
  updateRememberedProjectLifecycle,
} from "../src/app/project-directory";
import { mutateProjectLifecycle } from "../src/app/project-lifecycle";

const project = {
  slug: "alpha-12345678",
  name: "Alpha",
  views: [],
  notes: [],
};

test("catalog lifecycle is additive and absent metadata remains active", () => {
  expect(parseProjectCatalog({ schemaVersion: 1, projects: [project] })).toEqual([
    { ...project, lifecycle: { state: "active", visibility: "auto" } },
  ]);
  expect(
    parseProjectCatalog({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          lifecycle: {
            state: "inactive",
            visibility: "hidden",
            reason: "manual",
            emptySince: "2026-10-15T12:00:00.000Z",
          },
        },
      ],
    }),
  ).toEqual([
    {
      ...project,
      lifecycle: {
        state: "inactive",
        visibility: "hidden",
        reason: "manual",
        emptySince: "2026-10-15T12:00:00.000Z",
      },
    },
  ]);
});

test.each([
  { state: "gone", visibility: "auto" },
  { state: "active", visibility: "sometimes" },
  { state: "inactive", visibility: "hidden", reason: "expired" },
  { state: "inactive", visibility: "hidden", emptySince: "yesterday" },
  { state: "inactive", visibility: "hidden", emptySince: "2026-02-31T12:00:00.000Z" },
  { state: "active", visibility: "auto", extra: true },
])("catalog leaves out a project with malformed lifecycle metadata: %j", (lifecycle) => {
  expect(parseProjectCatalog({ schemaVersion: 1, projects: [{ ...project, lifecycle }] })).toEqual([]);
  expect(
    parseProjectCatalogEntries({ schemaVersion: 1, projects: [{ ...project, lifecycle }] })?.unavailable,
  ).toMatchObject([{ slug: project.slug, problem: "malformed" }]);
});

test("a malformed successful mutation response is uncertain and is never replayed", async () => {
  const fetcher = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          lifecycle: { state: "inactive", visibility: "hidden", emptySince: "2026-02-31T12:00:00.000Z" },
        }),
      }) as Response,
  );
  await expect(
    mutateProjectLifecycle(fetcher, "https://archer.test/projects/alpha-12345678/", project.slug, "archive"),
  ).resolves.toEqual({ ok: false, uncertain: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a server failure after a mutation request is uncertain and is never replayed", async () => {
  const fetcher = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
  await expect(
    mutateProjectLifecycle(fetcher, "https://archer.test/projects/alpha-12345678/", project.slug, "archive"),
  ).resolves.toEqual({ ok: false, uncertain: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("an acknowledged mutation invalidates an older catalog read before its confirmation", async () => {
  forgetProjectCatalogs();
  let resolveStale!: (response: Response) => void;
  let resolveFresh!: (response: Response) => void;
  const answer = (lifecycle: unknown): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ schemaVersion: 1, projects: [{ ...project, lifecycle }] }),
    }) as Response;
  const fetcher = vi
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(answer({ state: "active", visibility: "auto" }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = resolve;
        }),
    );
  await loadProjectCatalog(fetcher);
  markProjectCatalogStale();
  const stale = loadProjectCatalog(fetcher);
  updateRememberedProjectLifecycle(fetcher, project.slug, {
    state: "inactive",
    visibility: "hidden",
    reason: "manual",
  });
  const confirmation = loadProjectCatalog(fetcher);
  try {
    expect(fetcher).toHaveBeenCalledTimes(3);
    resolveFresh(answer({ state: "inactive", visibility: "hidden", reason: "manual" }));
    await confirmation;
    resolveStale(answer({ state: "active", visibility: "auto" }));
    await stale;
    expect(rememberedProjectCatalog(fetcher)).toMatchObject({
      status: "ready",
      projects: [{ lifecycle: { state: "inactive", visibility: "hidden" } }],
    });
  } finally {
    resolveFresh?.(answer({ state: "inactive", visibility: "hidden", reason: "manual" }));
    resolveStale?.(answer({ state: "active", visibility: "auto" }));
    forgetProjectCatalogs();
  }
});
