// Run under tsx with a sandbox's environment: issues one pairing code on the sandbox's own service
// (never starts one). Prints {code}. The code is a secret: callers must not print it.
import { createApplication } from "../../../../ts/src/application/index.ts";
import { connectIfRunning, ensureService } from "../../../../ts/src/service/client.ts";

const app = createApplication({
  cwd: process.cwd(),
  findService: () => connectIfRunning({ env: process.env }),
  ensureService: () => ensureService({ env: process.env }),
});
try {
  const answer = await app.call("issue_pairing_code", {});
  process.stdout.write(`${JSON.stringify({ code: (answer.structured as { code?: string }).code })}\n`);
} finally {
  app.close();
}
