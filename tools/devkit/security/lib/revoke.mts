// Run under tsx with a sandbox's environment (ARCHER_STATE_DIR …): revokes one access link on the
// sandbox's own service through the same operation the CLI and MCP use. Never starts a service.
//
//   tsx revoke.mts '<json: {grantId: string}>'     prints {revoked: boolean, ms: number}
import { createApplication } from "../../../../ts/src/application/index.ts";
import { connectIfRunning, ensureService } from "../../../../ts/src/service/client.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as { grantId: string };
const app = createApplication({
  cwd: process.cwd(),
  findService: () => connectIfRunning({ env: process.env }),
  ensureService: () => ensureService({ env: process.env }),
});
try {
  const started = performance.now();
  const answer = await app.call("revoke_access_link", { grantId: input.grantId });
  process.stdout.write(
    `${JSON.stringify({ revoked: (answer.structured as { revoked?: boolean }).revoked ?? null, ms: Math.round(performance.now() - started) })}\n`,
  );
} finally {
  app.close();
}
