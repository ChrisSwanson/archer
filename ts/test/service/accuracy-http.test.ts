import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanup, repo, manifest, FLOW, commit, write } from "../accuracy/support.ts";
import { cleanUp, service, http, apiBase } from "./support.ts";
import { connectService } from "../../src/service/service-client.ts";

afterEach(async () => {
  await cleanUp();
  cleanup();
});
test("browser accuracy endpoint delegates shared operations and refuses unrelated management", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/app.ts": "old" });
  commit(root);
  write(root, "src/app.ts", "new");
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const { url } = await client.call("attach", { root });
    const app = createApplication({ cwd: root });
    try {
      const reply = await http(apiBase(url) + "api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "list_stale_diagrams", arguments: {} }),
      });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual((await app.call("list_stale_diagrams")).structured);
      const forbidden = await http(apiBase(url) + "api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "stop_service", arguments: {} }),
      });
      expect(forbidden.status).toBe(422);
      expect(JSON.parse(forbidden.body)).toMatchObject({ error: { code: "invalid_request" } });
      const agentComment = await http(apiBase(url) + "api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "create_comment",
          arguments: { target: "view:flow", anchor: { kind: "view" }, body: "spoofed agent" },
        }),
      });
      expect(agentComment.status).toBe(422);
      expect(JSON.parse(agentComment.body)).toMatchObject({ error: { code: "invalid_request" } });
      const agentNoteEmphasis = await http(apiBase(url) + "api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "set_note_emphasis",
          arguments: { notePath: "note.md", id: "spoofed", groups: [], expectedRevision: 0 },
        }),
      });
      expect(agentNoteEmphasis.status).toBe(422);
      expect(JSON.parse(agentNoteEmphasis.body)).toMatchObject({ error: { code: "invalid_request" } });
      const cross = await http(apiBase(url) + "api/operations", {
        method: "POST",
        headers: { origin: "http://elsewhere.invalid", "content-type": "application/json" },
        body: JSON.stringify({ name: "list_stale_diagrams", arguments: {} }),
      });
      // The owner's cookie from another origin admits no write: the bare 404, before any route.
      expect(cross.status).toBe(404);
    } finally {
      app.close();
    }
  } finally {
    client.close();
  }
}, 15_000); // a real service and Git: 0.6 s idle, 2.6 s beside the UI and browser jobs; timed out at 5 s on CI
