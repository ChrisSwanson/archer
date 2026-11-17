// `archer present [view] [--file <args.json>|--stdin] [--json]` (ADR 0035 §3): a link reaches the person
// only when this call proved the service reachable and the page loadable. Otherwise it fails with the
// fix and the diagram's path relative to the project (`.archer/notes/x.md#flow`), for the agent to name.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { safe, UsageError, usage, type Io } from "./main.ts";

/** How long the page has to answer the check. */
export const PAGE_CHECK_MS = 5000;
/** Same-origin redirects followed to reach the page (the link's token exchange, then the canonical address). */
const MAX_PAGE_HOPS = 3;

const loopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127\./.test(host);

/** This computer's own addresses: a page there is reached without the link leaving the machine. */
function ownAddress(address: string): boolean {
  if (loopback(address)) return true;
  return Object.values(networkInterfaces()).some((list) => (list ?? []).some((entry) => entry.address === address));
}

/**
 * Whether the page at `url` loads: a GET of the link itself, following its same-origin redirects (the
 * token exchange), ends in a 2xx; a 404, an error page or a redirect elsewhere is not "loaded". On this
 * computer (loopback, or one of its own addresses, resolved once and pinned) the exact link is fetched and the service's own certificate is not checked: this is
 * reachability, not identity. Elsewhere the link's token goes only to a verified identity: over HTTPS
 * the certificate must verify; over plain HTTP the page is fetched without its query, so no token leaves.
 */
export async function checkPage(
  url: string,
  timeoutMs = PAGE_CHECK_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `the service gave a link that is not a URL (${url})` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: `the link is not a web address (${parsed.protocol})` };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let address = hostname;
  if (isIP(hostname) === 0 && hostname !== "localhost") {
    try {
      address = (await lookup(hostname)).address;
    } catch (error) {
      return {
        ok: false,
        reason: `the page's host does not resolve (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      };
    }
  }
  const own = hostname === "localhost" || ownAddress(address);
  const https = parsed.protocol === "https:";
  const first =
    own || https ? `${parsed.origin}${parsed.pathname}${parsed.search}` : `${parsed.origin}${parsed.pathname}`;
  // Pinned to the address checked above, so a second lookup cannot send the link elsewhere.
  const pinned = (
    _host: string,
    _options: unknown,
    done: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => done(null, address, isIP(address) === 6 ? 6 : 4);
  const get = (
    target: string,
    cookie: string,
  ): Promise<{ status: number; location?: string; cookies: string[] } | { failed: string }> =>
    new Promise((resolve) => {
      const send = https ? httpsRequest : httpRequest;
      const req = send(
        target,
        {
          method: "GET",
          timeout: timeoutMs,
          headers: cookie === "" ? {} : { cookie },
          ...(hostname === "localhost" ? {} : { lookup: pinned as never }),
          ...(https ? { rejectUnauthorized: !own } : {}),
        },
        (response) => {
          response.resume();
          const location = response.headers.location;
          resolve({
            status: response.statusCode ?? 0,
            ...(location === undefined ? {} : { location }),
            cookies: (response.headers["set-cookie"] ?? []).map((entry) => entry.split(";")[0]!),
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ failed: `the page did not answer within ${timeoutMs} ms` });
      });
      req.on("error", (error) =>
        resolve({ failed: `the page did not load (${(error as NodeJS.ErrnoException).code ?? error.message})` }),
      );
      req.end();
    });
  // The link may exchange its token for a cookie and land on the page (one or two same-origin hops).
  let target = first,
    cookies: string[] = [];
  for (let hop = 0; ; hop += 1) {
    const answer = await get(target, cookies.join("; "));
    if ("failed" in answer) return { ok: false, reason: answer.failed };
    if (answer.status >= 200 && answer.status < 300) return { ok: true };
    if (answer.status < 300 || answer.status >= 400 || answer.location === undefined || hop >= MAX_PAGE_HOPS)
      return { ok: false, reason: `the page answered HTTP ${answer.status}` };
    let next: URL;
    try {
      next = new URL(answer.location, target);
    } catch {
      return { ok: false, reason: `the page answered HTTP ${answer.status}` };
    }
    if (next.origin !== parsed.origin)
      return { ok: false, reason: `the page answered HTTP ${answer.status} to another address` };
    target = next.href;
    cookies = [...cookies, ...answer.cookies];
  }
}

/** The diagram's path relative to the project: the Archer folder, the file, and `#name` for an embedded one. */
export function projectPath(
  folderSetting: string,
  view: { readonly source: string; readonly name?: string | undefined },
): string {
  return `${folderSetting.replace(/\/+$/, "")}/${view.source}${view.name === undefined ? "" : `#${view.name}`}`;
}

/** Refusals about the request itself, not about reaching the page: shown as they are, with no path. */
const OWN_FAULT = new Set([
  "invalid_arguments",
  "invalid_emphasis",
  "invalid_expand",
  "revision_conflict",
  "diagram_not_found",
  "unknown_tool",
  "instance_choice_needed",
  "walkthrough_not_found",
]);

export async function runPresent(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { file: { type: "string" }, stdin: { type: "boolean" }, json: { type: "boolean" } },
    }),
  );
  if (positionals.length > 1 || (values.file !== undefined && values.stdin === true))
    throw new UsageError(
      "present takes one diagram (or none, for the project's page) and at most one of --file <json> or --stdin",
    );
  const operations = await import("./operations.ts");
  const payload =
    values.file !== undefined
      ? operations.readPayload(values.file, io)
      : values.stdin === true
        ? operations.parsePayload(await (io.stdin ?? (() => Promise.resolve("{}")))())
        : {};
  const viewId = positionals[0] ?? (typeof payload["viewId"] === "string" ? payload["viewId"] : undefined);
  const json = values.json === true;
  const { createApplication, OperationError } = await import("../application/index.ts");
  const { openProject, findView } = await import("../application/diagrams.ts");
  const { connectIfRunning, ensureService } = await import("../service/client.ts");
  const cwd = io.cwd ?? process.cwd();
  // Where the diagram is, worked out before any service is asked, so a failure can always name it.
  let where: string | undefined;
  try {
    const project = openProject(cwd);
    where =
      viewId === undefined
        ? undefined
        : projectPath(project.folderSetting, findView(project, viewId, "present_diagram"));
  } catch {
    /* the operation below refuses with the reason */
  }
  const refuse = (code: string, reason: string): number => {
    const fix =
      where === undefined
        ? "Do not give the person a link. Say Archer's page could not be reached from this session, and how to open it themselves: archer serve."
        : `Do not give the person a link. Name the file instead: ${where}`;
    io.stderr(
      json
        ? `${JSON.stringify({ code, message: reason, details: { ...(where === undefined ? {} : { path: where }), fix } })}\n`
        : `archer present: ${safe(reason)}\n${safe(fix)}\n`,
    );
    return 1;
  };
  const { callerAgentId, reportIn } = await import("./agents.ts");
  const { agentIdentity } = await import("../mcp/host-contract.ts");
  // A listener presenting its answer is busy, not away (decision 4).
  const reporting = reportIn(io);
  const app = createApplication({
    ...agentIdentity(callerAgentId(io)),
    cwd,
    env: io.env,
    version: (await import("../version.ts")).version(),
    findService: () => connectIfRunning({ env: io.env }),
    ensureService: () => ensureService({ env: io.env }),
    startService: () => ensureService({ env: io.env, autoStart: true }),
  });
  try {
    const result =
      viewId === undefined
        ? await app.call("get_ui_url", { outputFormat: "text" })
        : await app.call("present_diagram", { ...payload, viewId, outputFormat: "text" });
    const ui = result.structured["ui"] as { url?: unknown } | undefined;
    const url = String(ui?.url ?? result.structured["url"] ?? "");
    const page = await checkPage(url);
    if (!page.ok) return refuse("page_unreachable", `the service answered, but ${page.reason}`);
    // A diagram written with file tools is first checked here: its problems, label warnings and advice, as validate_diagram reports them.
    const lint = viewId === undefined ? null : await app.currentLint(viewId, { suggest: false });
    const linted = lint !== null && lint.text !== "";
    const layoutReview = (lint?.layoutReview?.suggestions as readonly unknown[] | undefined)?.length
      ? lint!.layoutReview
      : undefined;
    io.stdout(
      json
        ? `${JSON.stringify({ ...result.structured, checked: { url, loaded: true }, ...(linted ? { lint: { diagnostics: lint.diagnostics, advice: lint.advice, ...(lint.existingWarnings > 0 ? { existingWarnings: lint.existingWarnings } : {}), ...(layoutReview === undefined ? {} : { layoutReview }) } } : {}) })}\n`
        : `${safe(linted ? `${result.text}\n${lint.text}` : result.text)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const code = String(error.data.code);
    if (OWN_FAULT.has(code)) {
      io.stderr(
        json
          ? `${JSON.stringify({ code, message: error.message, details: error.data })}\n`
          : `archer: ${safe(error.message)}\n`,
      );
      return 1;
    }
    return refuse(code, error.message);
  } finally {
    app.close();
    await reporting;
  }
}
