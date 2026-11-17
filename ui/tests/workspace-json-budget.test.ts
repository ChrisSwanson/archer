// @vitest-environment jsdom
import { expect, it } from "vitest";
import { loadWorkspaceNotifications } from "../src/app/workspace-notifications";
it("refuses an oversized otherwise-valid catalog instead of parsing without a byte budget", async () => {
  const body = " ".repeat(8 * 1024 * 1024 + 1) + JSON.stringify({ schemaVersion: 1, projects: [] });
  const result = await loadWorkspaceNotifications(
    { kind: "service" },
    { href: "https://host/projects/", fetchImpl: async () => new Response(body) },
  );
  expect(result.status).toBe("error");
});
it("reads hidden 404s as refused access, never as an answer", async () => {
  const result = await loadWorkspaceNotifications(
    { kind: "service" },
    { href: "https://host/projects/", fetchImpl: async () => new Response("", { status: 404 }) },
  );
  expect(result.status).toBe("access-required");
});
