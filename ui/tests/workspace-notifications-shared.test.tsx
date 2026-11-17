// @vitest-environment jsdom
// The page's own notification reads on /projects/ (perf #7): the catalog stands for each project's
// connection and bootstrap; only the shared comment activity is read, unless it cannot be.
import { afterEach, expect, it, vi } from "vitest";
const seen: string[] = [];
let answer: (url: string) => Response = () => new Response("{}", { status: 200 });
vi.mock("../src/app/browser-resource", () => {
  const browserFetch = async (url: string) => {
    seen.push(url);
    return answer(url);
  };
  return { browserFetch, browserResourceUrl: (path: string) => path };
});
import { loadWorkspaceNotifications } from "../src/app/workspace-notifications";
import { forgetProjectCatalogs } from "../src/app/project-directory";
import { resources } from "../src/app/resources";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const catalog = {
  schemaVersion: 1,
  projects: [
    { slug: "alpha", name: "Alpha", views: [], notes: [] },
    { slug: "beta", name: "Beta", views: [], notes: [] },
  ],
};
const connection = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: [],
  applicationVersion: "0.1.0",
  semanticSchemaVersion: 2,
};
afterEach(() => {
  seen.length = 0;
  forgetProjectCatalogs();
  resources.forget();
});

it("reads only each listed project's comment activity", async () => {
  answer = (url) =>
    url === "api/browser-projects"
      ? json(catalog)
      : url.endsWith("api/comment-activity")
        ? json({ schemaVersion: 1, targets: {} })
        : json({}, 500);
  const result = await loadWorkspaceNotifications({ kind: "service" }, { href: "https://host/projects/" });
  expect(result.status).toBe("ready");
  expect(seen.filter((url) => /api\/(connection|bootstrap)$/.test(url))).toEqual([]);
  expect(seen.filter((url) => url.endsWith("api/comment-activity")).sort()).toEqual([
    "https://host/p/alpha/api/comment-activity",
    "https://host/p/beta/api/comment-activity",
  ]);
});

it("a project whose activity cannot be read is diagnosed as before", async () => {
  answer = (url) =>
    url === "api/browser-projects"
      ? json(catalog)
      : url.includes("/alpha/") && url.endsWith("api/comment-activity")
        ? json({ schemaVersion: 1, targets: {} })
        : url.endsWith("api/connection")
          ? json(connection)
          : url.endsWith("api/bootstrap")
            ? json({ capabilities: { comments: false } })
            : json({}, 404);
  const result = await loadWorkspaceNotifications({ kind: "service" }, { href: "https://host/projects/" });
  expect(result.status).toBe("partial");
  expect(seen).toContain("https://host/p/beta/api/bootstrap");
  expect(seen).not.toContain("https://host/p/alpha/api/bootstrap");
});
