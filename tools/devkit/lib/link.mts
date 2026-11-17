// Run by sandbox.mjs under tsx, with the sandbox's ARCHER_STATE_DIR in the environment: issues one more
// access link on the sandbox's own service (never starts a service).
//
//   tsx link.mts '<json: {label: string, authoringProjectRoots?: string[]}>'
//
// Without authoringProjectRoots the link is a read/comment link (a reader). Prints {id, url, token}.
import { createApplication } from "../../../ts/src/application/index.ts";
import { connectIfRunning, ensureService } from "../../../ts/src/service/client.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as { label: string; authoringProjectRoots?: string[] };
const app = createApplication({
  cwd: process.cwd(),
  findService: () => connectIfRunning({ env: process.env }),
  ensureService: () => ensureService({ env: process.env }),
});
try {
  const issued = await app.call("issue_access_link", {
    label: input.label,
    ...(input.authoringProjectRoots?.length ? { authoringProjectRoots: input.authoringProjectRoots } : {}),
  });
  const s = issued.structured as { id: string; url: string; token?: string };
  process.stdout.write(`${JSON.stringify({ id: s.id, url: s.url, token: s.token })}\n`);
} finally {
  app.close();
}
