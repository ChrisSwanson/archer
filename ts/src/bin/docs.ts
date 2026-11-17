import { parseArgs } from "node:util";
import { GUIDANCE, readGuidance } from "../guidance/index.ts";
import { isProfileFamily, PROFILE_FAMILIES, profileForFamily } from "../guidance/profile.ts";
import { PROFILE_URI } from "../mcp/tools.ts";
import { safe, UsageError, usage, type Io } from "./main.ts";

/** Trusted installation guidance, independent of project discovery and service state. */
export async function runDocs(args: readonly string[], io: Io): Promise<number> {
  if (args[0] === "index") return docsIndex(args.slice(1), io);
  const { values, positionals } = usage(() =>
    parseArgs({ args: [...args], allowPositionals: true, options: { json: { type: "boolean" } } }),
  );
  if (
    (positionals.length > 1 && positionals[0] !== "supported-mermaid") ||
    positionals.length > 2 ||
    (positionals.length >= 1 && values.json)
  )
    throw new UsageError(
      "archer docs takes one guide name (supported-mermaid may add a family), or --json to list guides",
    );
  const guides = [
    ...GUIDANCE.map(({ id, uri, title, description }) => ({ id, uri, title, description })),
    {
      id: "supported-mermaid",
      uri: PROFILE_URI,
      title: "Supported Mermaid profile",
      description: "Accepted syntax, identities and limits for each supported family.",
    },
  ];
  const id = positionals[0];
  if (id === undefined) {
    io.stdout(
      values.json
        ? `${JSON.stringify({ guides }, null, 2)}\n`
        : guides.map((guide) => `${guide.id}: ${guide.title}\n  ${guide.uri}\n`).join(""),
    );
    return 0;
  }
  if (id === "supported-mermaid") {
    const { defaultProfile } = await import("../application/index.ts");
    const family = positionals[1];
    if (family !== undefined && !isProfileFamily(family))
      throw new UsageError(`archer docs supported-mermaid: unknown family; choose ${PROFILE_FAMILIES.join(", ")}`);
    io.stdout(family === undefined ? defaultProfile() : profileForFamily(defaultProfile(), family));
    return 0;
  }
  const guide = GUIDANCE.find((guide) => guide.id === id);
  if (!guide)
    throw new UsageError(
      "archer docs: unknown guide; choose surfaces, authoring, cli, mcp, admin, docs-mode, walkthroughs, supported-mermaid or index",
    );
  io.stdout(readGuidance(guide.id));
  return 0;
}

/**
 * `archer docs index [--write] [--check] [--json] [question…]`: the docs_index operation for this
 * project (docs/proposals/doc-pack.md). --check exits 1 when the pack's health fails.
 */
async function docsIndex(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { write: { type: "boolean" }, check: { type: "boolean" }, json: { type: "boolean" } },
    }),
  );
  const question = positionals.join(" ").trim();
  const { createApplication, OperationError } = await import("../application/index.ts");
  const app = createApplication({ cwd: io.cwd ?? process.cwd(), env: io.env });
  try {
    const result = await app.call("docs_index", {
      ...(values.write === true ? { write: true } : {}),
      ...(values.check === true ? { check: true } : {}),
      ...(question === "" ? {} : { question }),
      outputFormat: values.json === true ? "json" : "text",
    });
    io.stdout(values.json === true ? `${JSON.stringify(result.structured)}\n` : `${safe(result.text)}\n`);
    const health = result.structured["health"] as { status?: string } | undefined;
    return health?.status === "fail" ? 1 : 0;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    io.stderr(`archer: ${safe(error.message)}\n`);
    return 1;
  } finally {
    app.close();
  }
}
