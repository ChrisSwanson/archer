import { expect, test } from "vitest";
import { readBrowserRoute, browserRoutePath, legacyEditAddress } from "../src/app/browser-routes";
test("authoring has one project-scoped edit route and rejects extra path identity", () => {
  // Canonical: a reserved system route, so a project folder named `edit` keeps its clean address.
  expect(browserRoutePath({ kind: "edit", projectSlug: "example-123" })).toBe("/projects/example-123/-/edit/");
  expect(readBrowserRoute("/projects/example-123/-/edit/")).toEqual({ kind: "edit", projectSlug: "example-123" });
  expect(readBrowserRoute("/projects/example-123/edit/")).toEqual({
    kind: "browse",
    projectSlug: "example-123",
    folder: "edit",
  });
  expect(browserRoutePath({ kind: "browse", projectSlug: "example-123", folder: "edit" })).toBe(
    "/projects/example-123/edit/",
  );
  expect(readBrowserRoute("/projects/example-123/-/edit")).toBeNull();
  expect(readBrowserRoute("/projects/example-123/-/edit/extra/")).toBeNull();
  // The retired `/p/<name>/edit/` form (0.15.0) is no page.
  expect(readBrowserRoute("/p/example-123/edit/")).toBeNull();
  expect(readBrowserRoute("/p/example-123/edit/extra/")).toBeNull();
});

test("the old editor address with ?viewId= names its in-place address, the draft, checkpoint and Source pane kept", () => {
  const o = "http://127.0.0.1:1";
  const draft = `drf_${"a".repeat(32)}`;
  expect(legacyEditAddress(`${o}/projects/demo/-/edit/?viewId=diagrams/flow.mmd`)).toBe(
    "/projects/demo/diagrams/flow.mmd?edit",
  );
  expect(legacyEditAddress(`${o}/projects/demo/-/edit/?viewId=flow.mmd&draftId=${draft}&checkpoint=draft&source`)).toBe(
    `/projects/demo/flow.mmd?edit&draftId=${draft}&checkpoint=draft&source`,
  );
  expect(legacyEditAddress(`${o}/projects/demo/-/edit/?viewId=flow.mmd&draftId=bad`)).toBe(
    "/projects/demo/flow.mmd?edit",
  );
  expect(legacyEditAddress(`${o}/projects/demo/-/edit/`)).toBeNull();
  expect(legacyEditAddress(`${o}/projects/demo/flow.mmd?edit`)).toBeNull();
});
