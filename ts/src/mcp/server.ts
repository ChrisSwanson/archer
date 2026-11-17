// Thin MCP adapter: the application owns validation, behavior and results.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApplication, defaultProfile, OperationError, type ApplicationOptions } from "../application/index.ts";
import { toolError, toMcpError, quoted } from "./errors.ts";
import { PROFILE_URI, SOURCE_URI_TEMPLATE, TOOLS } from "./tools.ts";
import { installationAsset } from "../assets.ts";
import { GUIDANCE, readGuidance, type GuidanceId } from "../guidance/index.ts";
import { isProfileFamily, PROFILE_FAMILIES, profileForFamily } from "../guidance/profile.ts";
import { pendingChangeHint } from "../application/changes.ts";
import { SURFACES_RULE } from "../guidance/surfaces.ts";
export interface ArcherServerOptions extends ApplicationOptions {
  /** Declares `tools.listChanged`: the service's relay host (host.ts), whose tools change on a hot swap. */
  readonly listChanged?: boolean;
  readonly uiHtml?: () => string;
  readonly guidanceText?: (id: GuidanceId) => string;
}
const UI_URI = "ui://archer/diagram";
const UI_MIME = "text/html;profile=mcp-app";
const UI_META = { ui: { resourceUri: UI_URI }, "ui/resourceUri": UI_URI };
// The bundled native ELK worker uses a local blob URL. No network origins are granted.
const RESOURCE_META = {
  ui: { csp: { connectDomains: [], resourceDomains: ["blob:"], frameDomains: [], baseUriDomains: [] } },
};
const INSTRUCTIONS =
  "Archer shows Mermaid diagrams and notes from the project's Archer folder (default .archer/) to the person in a browser page. " +
  `${SURFACES_RULE} ` +
  'If archer.toml sets mode = "docs", read archer://docs/docs-mode first. ' +
  "Choose by question: C4 for structure, flowchart for process or data flow, sequence for message order; honor the user's scope and notation; a table or prose may fit better. " +
  "Before writing Mermaid read archer://docs/supported-mermaid/<family> (flowchart, sequence, state, er, c4, architecture, journey); archer://docs/authoring and archer://docs/cli hold the rest. " +
  "Compiling does not prove architectural correctness: draw only the facts. " +
  "A new subject gets a new diagram, by default embedded as a top-level ```mermaid block (first line %% archer-id: <name>) in a new note in notes/ with front matter author: agent and description:; " +
  "a new diagram that deserves its own file goes in diagrams/ with a %% description: line. " +
  "Do not move existing files or replace them with another subject; offer descriptions for files that lack one, never add them unasked. " +
  "Create the note first, then validate_diagram at <note path>#<name> with the source you wrote, fix every problem and label warning, present_diagram and give its returned URL exactly. " +
  "For instructions or a guide the note is the deliverable: link its page (noteUrl, or get_ui_url with notePath), the diagram only as its figure. " +
  "Change an existing diagram with read_diagram then write_diagram (its sourceRevision as expectedRevision), not file edits, so the person sees what changed; its fresh modelRevision is the one to present. " +
  "A block nested in a list or blockquote stays put: relocate: true only in your own note (author: agent) or when the person asks (with personRequested: true). " +
  "The diagrams are the project's documentation; unless the person asks for another form, when asked how something works, find the diagram that shows it (list_diagrams, read_diagram), present_diagram with emphasis on the path in one call (on a sequence, its messages in order; set_emphasis changes it later) and answer in a few sentences with the URL, naming the diagram: no new diagram, no source edit; if it lacks a part, say so and offer the change. " +
  "If a walkthrough covers the question (list_diagrams shows walkthroughs: N), present_diagram with walkthrough {id, step} instead of emphasis; write one only when asked (archer://docs/walkthroughs). " +
  "For more detail than it shows, elaborate in a copy, never the original: a new note in notes/scratch/ with based-on: <view id>@<sourceRevision> in its front matter; change the original only when asked. If no diagram shows the steps asked about, draw them from what you were told in a new note in notes/scratch/, and say in your answer that none existed. " +
  "Before a non-trivial code change nobody has approved yet, show it first: a scratch copy of the covering diagram with the change emphasised (labels say (proposed), or (assumed) for a guess), a short list of your assumptions and one open question, then wait for the go-ahead. After a code change, run list_stale_diagrams and offer to update stale diagrams, never unasked. " +
  "On a setup or access error, follow the fix it names. Don't stop or hand config editing to the person; ask only for the yes it requires. " +
  "On instance_choice_needed ask the person, run the command for their choice (archer preferences set instances … records it), then follow ~/.archer/preferences.md.";

export function createArcherServer(options: ArcherServerOptions): Server {
  const server = new Server(
    { name: "archer", version: options.version ?? "0.0.0-dev" },
    {
      capabilities: { tools: options.listChanged === true ? { listChanged: true } : {}, resources: {} },
      instructions: INSTRUCTIONS,
    },
  );
  const supportsApps = (): boolean => {
    const extension = server.getClientCapabilities()?.extensions?.["io.modelcontextprotocol/ui"] as
      | { mimeTypes?: unknown }
      | undefined;
    return Array.isArray(extension?.mimeTypes) && extension.mimeTypes.includes(UI_MIME);
  };
  // The person's own answer, asked by the client itself (MCP elicitation): consent an agent cannot fake.
  const askPerson = async (question: string): Promise<"yes" | "no" | "unsupported"> => {
    if (server.getClientCapabilities()?.elicitation === undefined) return "unsupported";
    try {
      const answer = await server.request(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: question,
            requestedSchema: {
              type: "object",
              properties: { open: { type: "boolean", title: "Open Archer to my network", default: false } },
              required: ["open"],
            },
          },
        },
        ElicitResultSchema,
        { timeout: 300_000 },
      );
      // Only an accepted yes is a yes. A decline or a cancel, however fast, is a no: never a fallback to the agent's word.
      if (answer.action === "accept")
        return (answer.content as { open?: unknown } | undefined)?.open === true ? "yes" : "no";
      process.stderr.write(`[archer] setup_network_access: the person's answer was ${answer.action}\n`);
      return "no";
    } catch (error) {
      // "Cannot ask" only from explicit signals: no elicitation capability (above), or the method is not found.
      // Then the client's approval of the call (the tool's annotations) is the safeguard. Any other failure is a no.
      return error instanceof McpError && error.code === ErrorCode.MethodNotFound ? "unsupported" : "no";
    }
  };
  const application = createApplication({
    ...options,
    askPerson,
    presentationSurface: () => (supportsApps() ? "embedded" : "browser"),
  });
  const withoutChangeHint = new Set([
    "setup_network_access",
    "start_service",
    "stop_service",
    "list_projects",
    "attach_project",
    "detach_project",
    "issue_access_link",
    "list_access_links",
    "revoke_access_link",
    "issue_pairing_code",
    "issue_authoring_access",
    "list_changes",
    "read_change",
    "resolve_change",
  ]);
  const seenPending = new Map<string, string>();
  const connectionEpochs = new WeakMap<object, number>();
  let nextConnectionEpoch = 0;
  let lookupInFlight = false;
  const timedOut = Symbol("pending-change-lookup-timeout");
  const supplement = async (): Promise<string | null> => {
    // A deadline stops waiting, not the underlying IPC. Do not enqueue another
    // request or attach another waiter while a timed-out lookup remains live.
    if (lookupInFlight)
      return "[Archer: saved-change feed unavailable — an earlier lookup remains in flight; primary operation completed unchanged.]";
    lookupInFlight = true;
    const lookup = application.pendingChangeSummary().then(
      (summary) => {
        lookupInFlight = false;
        return summary;
      },
      (error) => {
        lookupInFlight = false;
        throw error;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), 250);
        timer.unref();
      });
      // Promise.race installs rejection handlers on the late lookup as well.
      // No dedup state changes until a lookup actually finishes in time.
      const summary = await Promise.race([lookup, timeout]);
      if (summary === timedOut)
        return "[Archer: saved-change feed unavailable — lookup deadline exceeded; primary operation completed unchanged.]";
      if (summary === null) {
        seenPending.clear();
        return null;
      }
      const { root, page, connection } = summary;
      if (
        page.records.length === 0 &&
        (page.cumulativeReviews?.reviews.length ?? 0) === 0 &&
        page.cumulativeFeedHealth === undefined
      ) {
        seenPending.delete(root);
        return null;
      }
      let epoch = connectionEpochs.get(connection);
      if (epoch === undefined) {
        epoch = ++nextConnectionEpoch;
        connectionEpochs.set(connection, epoch);
      }
      // Change IDs contain store/generation identity. Include review state,
      // omitted work and the connection epoch so reconnects reconcile again.
      const fingerprint = JSON.stringify([
        epoch,
        page.upperSequence,
        page.omittedCount,
        page.records.map((record) => [record.changeId, record.reviewRevision]),
        page.cumulativeFeedHealth ?? null,
        page.cumulativeReviews
          ? [
              page.cumulativeReviews.upperSequence,
              page.cumulativeReviews.omittedCount,
              page.cumulativeReviews.hasMore,
              page.cumulativeReviews.reviews.map((review) => [review.reviewId, review.reviewRevision]),
            ]
          : null,
      ]);
      if (seenPending.get(root) === fingerprint) return null;
      const hint = pendingChangeHint(page);
      if (hint !== null) {
        // cwd is application-owned, but a moved checkout can discover a new
        // canonical root. Keep reconciliation history bounded across such moves.
        if (!seenPending.has(root) && seenPending.size >= 32) seenPending.delete(seenPending.keys().next().value!);
        seenPending.set(root, fingerprint);
      }
      return hint;
    } catch {
      return "[Archer: saved-change feed unavailable; primary operation completed unchanged. Use list_changes to reconcile when available.]";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    application.close();
    await originalClose();
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
      ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
      ...(["present_diagram", "set_emphasis"].includes(t.name) ? { _meta: UI_META } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    try {
      const answer = await application.call(name, args);
      const structured =
        supportsApps() && name === "present_diagram"
          ? { ...answer.structured, ui: { mode: "mcp-app", resourceUri: UI_URI } }
          : answer.structured;
      const content: { type: "text"; text: string }[] = [{ type: "text", text: answer.text }];
      if (!withoutChangeHint.has(name)) {
        const hint = await supplement();
        if (hint !== null) content.push({ type: "text", text: hint });
      }
      return {
        content,
        ...(args["outputFormat"] === "text"
          ? ["present_diagram", "set_emphasis"].includes(name)
            ? { _meta: { "archer/ui": structured } }
            : {}
          : { structuredContent: structured }),
      };
    } catch (error) {
      if (error instanceof OperationError) throw toMcpError(error);
      throw error;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: UI_URI, name: "archer_diagram", title: "Archer diagram", mimeType: UI_MIME },
      {
        uri: PROFILE_URI,
        name: "supported_mermaid",
        title: "Supported Mermaid profile",
        description:
          "The Mermaid subsets Archer accepts and refuses for flowchart, sequence, state, ER, C4, architecture and journey: syntax, family-specific identities and limits. Read before authoring.",
        mimeType: "text/markdown",
      },
      ...GUIDANCE.map(({ uri, name, title, description }) => ({
        uri,
        name,
        title,
        description,
        mimeType: "text/markdown",
      })),
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: SOURCE_URI_TEMPLATE,
        name: "diagram_source",
        description: "A view's Mermaid source as it is on disk.",
        mimeType: "text/plain",
      },
      {
        uriTemplate: `${PROFILE_URI}/{family}`,
        name: "supported_mermaid_family",
        description: `The supported-Mermaid profile for one family (${PROFILE_FAMILIES.join(", ")}): read it before drawing that family.`,
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;
    try {
      if (uri === UI_URI)
        return {
          contents: [
            {
              uri,
              mimeType: UI_MIME,
              text: (options.uiHtml ?? (() => installationAsset("archer-mcp-app.html").toString("utf8")))(),
              _meta: RESOURCE_META,
            },
          ],
        };
      if (uri === PROFILE_URI)
        return { contents: [{ uri, mimeType: "text/markdown", text: (options.profileText ?? defaultProfile)() }] };
      if (uri.startsWith(`${PROFILE_URI}/`)) {
        const family = uri.slice(PROFILE_URI.length + 1);
        if (!isProfileFamily(family))
          throw toolError(
            "resource_not_found",
            `Archer has no resource ${quoted(uri)}: choose ${PROFILE_URI}/<family> with ${PROFILE_FAMILIES.join(", ")}.`,
          );
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: profileForFamily((options.profileText ?? defaultProfile)(), family),
            },
          ],
        };
      }
      const guide = GUIDANCE.find((reference) => reference.uri === uri);
      if (guide !== undefined)
        return {
          contents: [{ uri, mimeType: "text/markdown", text: (options.guidanceText ?? readGuidance)(guide.id) }],
        };
      const match = /^archer:\/\/diagram\/([^/]+)\/source$/.exec(uri);
      if (match?.[1] !== undefined) return application.sourceResource(uri, decodeURIComponent(match[1]));
      throw toolError(
        "resource_not_found",
        `Archer has no resource ${quoted(uri)}. Available resources: ${[UI_URI, PROFILE_URI, ...GUIDANCE.map((guide) => guide.uri), SOURCE_URI_TEMPLATE].join(", ")}. Use resources/list to discover them.`,
      );
    } catch (error) {
      if (error instanceof OperationError) throw toMcpError(error);
      throw error;
    }
  });

  return server;
}
