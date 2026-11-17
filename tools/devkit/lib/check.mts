// Run by `sandbox.mjs check` under tsx with the sandbox's environment: compiles every view and
// every embedded diagram of each project root through the service (read_diagram), so a corpus is
// known to compile before journeys rely on it. Prints one JSON line per project.
import { createApplication } from "../../../ts/src/application/index.ts";
import { connectIfRunning, ensureService } from "../../../ts/src/service/client.ts";

for (const root of JSON.parse(process.argv[2] ?? "[]") as string[]) {
  const app = createApplication({
    cwd: root,
    findService: () => connectIfRunning({ env: process.env }),
    ensureService: () => ensureService({ env: process.env }),
  });
  try {
    const listed = (await app.call("list_diagrams", { outputFormat: "json" })).structured as {
      views: { id: string; kind: string }[];
      embedded: { address: string; kind: string; writable: boolean }[];
    };
    const targets = [
      ...(listed.views ?? []).map((v) => ({ id: v.id, kind: v.kind })),
      ...(listed.embedded ?? []).map((e) => ({ id: e.address, kind: e.kind, writable: e.writable })),
    ];
    const results = [];
    for (const t of targets) {
      try {
        const read = (await app.call("read_diagram", { viewId: t.id, outputFormat: "json" })).structured as {
          compile?: { status?: string; diagnostics?: { code: string; severity?: string; message: string }[] };
        };
        const errors = (read.compile?.diagnostics ?? [])
          .filter((d) => d.severity === "error")
          .map((d) => `${d.code}: ${d.message}`.slice(0, 200));
        results.push({ ...t, status: read.compile?.status ?? "unknown", ...(errors.length ? { errors } : {}) });
      } catch (error) {
        results.push({ ...t, status: "read-failed", error: String((error as Error).message).slice(0, 200) });
      }
    }
    process.stdout.write(
      `${JSON.stringify({ root, total: results.length, compiled: results.filter((r) => r.status === "compiled").length, results })}\n`,
    );
  } finally {
    app.close();
  }
}
