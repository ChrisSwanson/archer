// Run by sandbox.mjs under tsx, with the sandbox's ARCHER_STATE_DIR in the environment:
// attaches each project root through the same operations the CLI and MCP use, then issues one
// editing link for all of them. Never starts a service (no autoStart), so it cannot reach
// any service other than the sandbox's own socket.
//
//   tsx provision.mts '<json: {roots: string[], label: string}>'
//
// Prints one JSON line: {projects:[{root, name, url}], link:{id, url, token}}.
import { createApplication } from "../../../ts/src/application/index.ts";
import { connectIfRunning, ensureService } from "../../../ts/src/service/client.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as { roots: string[]; label: string };
const app = createApplication({
  cwd: process.cwd(),
  findService: () => connectIfRunning({ env: process.env }),
  // No autoStart: only the sandbox service already listening on this state dir is reached.
  ensureService: () => ensureService({ env: process.env }),
});
try {
  const projects: { root: string; name: string; url: string }[] = [];
  for (const root of input.roots) {
    const answer = await app.call("attach_project", { root });
    const project = answer.structured["project"] as { name: string; url: string; root?: string };
    projects.push({ root, name: project.name, url: project.url });
  }
  const issued = await app.call("issue_access_link", {
    label: input.label,
    ...(input.roots.length ? { authoringProjectRoots: input.roots } : {}),
  });
  const s = issued.structured as { id: string; url: string; token?: string };
  process.stdout.write(`${JSON.stringify({ projects, link: { id: s.id, url: s.url, token: s.token } })}\n`);
} finally {
  app.close();
}
