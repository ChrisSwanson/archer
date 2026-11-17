// The route table's matcher (shared/api-routes.mts): precedence is table order, parameters are decoded, a
// parameter's pattern and an ordinary literal are matched as sent, and the comments routes compare decoded.
import { expect, test } from "vitest";
import { API_ROUTES, matchApiRoute } from "../../../shared/api-routes.mts";
import { routeHandlers } from "../../src/service/routes.ts";

const id = (method: string, scope: "project" | "service", path: string): string | null =>
  matchApiRoute(method, scope, path.split("/"))?.spec.id ?? null;

test("every route id is distinct, and every path starts at api/<name>", () => {
  expect(new Set(API_ROUTES.map((spec) => spec.id)).size).toBe(API_ROUTES.length);
  expect(API_ROUTES.filter((spec) => spec.path[0] !== "api" || spec.path[1] !== spec.name)).toEqual([]);
});

test("scope, method and depth select one entry; anything else matches none", () => {
  expect(id("GET", "service", "api/projects")).toBe("projects");
  expect(id("GET", "project", "api/projects")).toBe("projects");
  expect(id("GET", "service", "api/diagrams")).toBeNull();
  expect(id("POST", "project", "api/diagrams")).toBeNull();
  expect(id("GET", "project", "api/diagrams/x/y")).toBeNull();
  expect(id("PUT", "service", "api/settings")).toBe("settings-put");
  expect(id("DELETE", "service", "api/settings")).toBeNull();
});

test("the first entry wins: authoring's status takes GET, its mutation every other method", () => {
  expect(id("GET", "project", "api/authoring")).toBe("authoring-status");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
    expect(id(method, "project", "api/authoring")).toBe("authoring-mutate");
});

test("a parameter is decoded; its pattern and a literal are matched as sent", () => {
  expect(matchApiRoute("GET", "project", ["api", "diagrams", "a%2Fb"])?.params).toEqual({ viewId: "a/b" });
  expect(id("GET", "project", "api/diagrams/%ZZ")).toBeNull();
  expect(id("GET", "project", "api/walkthroughs/%6Fld")).toBeNull();
  const hex = "a1".repeat(16);
  expect(id("GET", "project", `api/authoring/operations/${hex}`)).toBe("authoring-operation");
  expect(id("GET", "project", `api/authoring/operations/%61${hex.slice(1)}`)).toBeNull();
});

test("the comments and notes routes compare their literals decoded, as they decode every id", () => {
  expect(id("GET", "project", "api/comments/%70ending")).toBe("comments-pending");
  expect(id("POST", "project", "api/comments/t%31/replies")).toBe("comments-reply");
  expect(matchApiRoute("PATCH", "project", ["api", "comments", "t%31", "c%32"])?.params).toEqual({
    threadId: "t1",
    commentId: "c2",
  });
  expect(id("DELETE", "project", "api/comments/%ZZ/c")).toBeNull();
});

test("an entry the caller does not admit is passed over for the next", () => {
  expect(matchApiRoute("GET", "project", ["api", "authoring"], (spec) => spec.id !== "authoring-status")?.spec.id).toBe(
    "authoring-mutate",
  );
});

test("handlers name table entries, once each", () => {
  const handle = (): void => {};
  expect(() => routeHandlers([{ id: "no-such-route", handle }])).toThrow(/no API route/);
  expect(() =>
    routeHandlers([
      { id: "compile", handle },
      { id: "compile", handle },
    ]),
  ).toThrow(/two handlers/);
});
