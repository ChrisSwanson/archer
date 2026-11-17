// The management socket's methods (protocol.ts), answered for startService: changes and reviews, projects,
// access, presentation, listeners and lifecycle. startService admits each request (stopping, the drain count,
// saved projects still opening) and passes it here; this maps store and policy refusals to their wire codes.
import { listCumulativeReviews, readCumulativeReview } from "../authoring/review-feed.ts";
import type { ReviewArtifactOptions, ReviewArtifactResult } from "../authoring/review-artifacts.ts";
import { savedChangeEvidence } from "../authoring/change-evidence.ts";
import { type AuthoringStore, AuthoringStoreError } from "../authoring/store.ts";
import { type AccountStateStore, PersistenceError } from "../state/account.ts";
import type { ChangeStore } from "../changes/index.ts";
import { listPendingChanges, readChangeDetail } from "../changes/review.ts";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { ResolvedServiceSettings } from "../config/resolve.ts";
import type { PreparedTransport, TransportOptions } from "./transport.ts";
import { version } from "../bin/main.ts";
import { findProject } from "../project/index.ts";
import { isLoopback } from "./http.ts";
import { ProjectState, StateRefusal } from "./project-state.ts";
import { PROTOCOL_VERSION, type Method, type ProjectStatus, type Request, type Results } from "./protocol.ts";
import { MethodError, type ConnectionContext } from "./socket.ts";
import type { Delivery } from "./listeners.ts";
import type { AccessGrantStore } from "./access-grants.ts";
import type { PairingCodes } from "./pairing-codes.ts";
import type { AuthoringGrantStore } from "./authoring-grants.ts";
import { launchBrowser } from "./browser.ts";
import type { ProjectWatcher } from "./watch.ts";
import { admissionRefusal, WriteRuleDenied } from "../config/write-policy.ts";
import type { ProjectLifecycleMetadata } from "../state/project-lifecycle.ts";
import type { DiscoverySettings } from "../project/discovery.ts";
import type { Telemetry } from "../telemetry/index.ts";
import type { LazyStore } from "./lazy-store.ts";
import type { ServiceOptions } from "./service.ts";

type Project = { state: ProjectState; watcher: ProjectWatcher };

/**
 * What the management methods read and do, from startService. Every value is read when a request is answered:
 * collections are passed as the service's own (never copies), and stores through their getters.
 */
export interface ManagementDeps {
  readonly options: ServiceOptions;
  readonly log: (line: string) => void;
  readonly serviceName: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly host: string;
  readonly port: number;
  readonly advertisedHost: string;
  readonly transport: PreparedTransport;
  readonly transportOptions: TransportOptions;
  readonly configuredTransport: Pick<ResolvedServiceSettings, "pairingCodeMinutes">;
  readonly admission: ResolvedServiceSettings["admission"];
  readonly restoreState: boolean;
  readonly openBrowser: boolean;
  readonly maxProjects: number;
  /** The page served (its path), and the previous build's kept with it, for restartConfiguration. */
  readonly page: string;
  readonly retainedPage: string | undefined;
  readonly homeUrl: string;
  readonly pageUrl: (slug: string) => string;
  // Projects: the service's own maps and sets.
  readonly projects: Map<string, Project>;
  readonly restoring: ReadonlyMap<string, Promise<void>>;
  readonly restoringStatus: Map<string, ProjectStatus>;
  readonly restoreCancelled: Set<string>;
  readonly restoreFailures: Map<string, { code: string; message: string }>;
  readonly store: AccountStateStore;
  readonly projectKey: (root: string) => string | null;
  readonly projectName: (root: string) => string;
  readonly attached: (root: string) => ProjectState;
  readonly status: (state: ProjectState) => ProjectStatus;
  readonly register: (root: string, entry: Project) => void;
  readonly discoverySettings: (state: ProjectState) => DiscoverySettings;
  readonly observeLifecycle: (state: ProjectState, automaticEligible: boolean) => ProjectLifecycleMetadata;
  readonly watchProject: (state: ProjectState) => ProjectWatcher;
  readonly watchThumbnails: (state: ProjectState) => void;
  readonly endStreams: (state?: ProjectState) => void;
  readonly telemetry: Telemetry | null;
  // Changes and reviews.
  readonly getChanges: () => ChangeStore;
  readonly savedAuthoring: Pick<LazyStore<AuthoringStore>, "peek">;
  readonly getSavedAuthoring: () => AuthoringStore;
  readonly reviewArtifact: (root: string, reviewId: string, options?: ReviewArtifactOptions) => ReviewArtifactResult;
  readonly artifactJobs: { schedule(root: string): void };
  // Access.
  readonly grants: AccessGrantStore;
  readonly grantStreams: Map<ServerResponse, string>;
  readonly pairing: PairingCodes;
  readonly getAuthoringGrants: () => AuthoringGrantStore;
  readonly unbracket: (host: string) => string;
  // Listeners and lifecycle.
  readonly delivery: Delivery;
  /** Stops the service; `true` hands over (ADR 0032). */
  readonly close: (handingOver?: boolean) => Promise<void>;
}

/** The management methods; `reload` false: a read answers from the served state (pageClient). */
export type ManagementHandler = (
  request: Request,
  reload: boolean,
  connection?: ConnectionContext,
) => Promise<Results[Method]>;

export function createManagementHandler(deps: ManagementDeps): ManagementHandler {
  const {
    options,
    log,
    serviceName,
    stateDir,
    socketPath,
    host,
    port,
    advertisedHost,
    transport,
    transportOptions,
    configuredTransport,
    admission,
    restoreState,
    openBrowser,
    maxProjects,
    page,
    retainedPage,
    homeUrl,
    pageUrl,
    projects,
    restoring,
    restoringStatus,
    restoreCancelled,
    restoreFailures,
    store,
    projectKey,
    projectName,
    attached,
    status,
    register,
    discoverySettings,
    observeLifecycle,
    watchProject,
    watchThumbnails,
    endStreams,
    telemetry,
    getChanges,
    savedAuthoring,
    getSavedAuthoring,
    reviewArtifact,
    artifactJobs,
    grants,
    grantStreams,
    pairing,
    getAuthoringGrants,
    unbracket,
    delivery,
    close,
  } = deps;
  let browserAttempted = false;
  return async (request, reload, connection) => {
    try {
      switch (request.method) {
        case "pendingChanges": {
          const root = attached(request.params.root).root;
          const page = listPendingChanges(getChanges(), root, request.params.limit ?? 3);
          if (!savedAuthoring.peek() && !existsSync(join(stateDir, "runtime", "authoring", "index.json"))) return page;
          try {
            return {
              ...page,
              cumulativeReviews: listCumulativeReviews(
                getSavedAuthoring(),
                root,
                request.params.limit ?? 3,
                undefined,
                true,
              ),
            };
          } catch {
            return { ...page, complete: false, cumulativeFeedHealth: "unavailable" as const };
          }
        }
        case "listChanges": {
          const root = attached(request.params.root).root;
          const page = listPendingChanges(getChanges(), root, request.params.limit ?? 20, request.params.cursor);
          if (!savedAuthoring.peek() && !existsSync(join(stateDir, "runtime", "authoring", "index.json"))) return page;
          try {
            return {
              ...page,
              cumulativeReviews: listCumulativeReviews(
                getSavedAuthoring(),
                root,
                request.params.limit ?? 20,
                request.params.reviewCursor,
              ),
            };
          } catch (failure) {
            if (request.params.reviewCursor) throw failure;
            return { ...page, complete: false, cumulativeFeedHealth: "unavailable" as const };
          }
        }
        case "readReview": {
          const root = attached(request.params.root).root;
          const detail = readCumulativeReview(getSavedAuthoring(), root, request.params.reviewId, request.params.part);
          const artifact = reviewArtifact(root, request.params.reviewId);
          return { ...detail, artifact };
        }
        case "clearReview": {
          const root = attached(request.params.root).root;
          const review = getSavedAuthoring().clearReview(
            root,
            request.params.reviewId,
            request.params.expectedReviewRevision,
            request.params.summary,
          );
          return { review, artifact: reviewArtifact(root, review.reviewId) };
        }
        case "readChange": {
          const root = attached(request.params.root).root;
          return readChangeDetail(getChanges(), root, request.params.changeId, request.params.part, (record) => {
            let journal = savedAuthoring.peek();
            if (!journal && existsSync(join(stateDir, "runtime", "authoring", "index.json"))) {
              try {
                journal = getSavedAuthoring();
              } catch {
                /* Saved work remains readable without journal evidence. */
              }
            }
            return savedChangeEvidence(journal, record);
          });
        }
        case "resolveChange": {
          const root = attached(request.params.root).root;
          return {
            record: getChanges().resolveReview(
              root,
              request.params.changeId,
              request.params.expectedReviewRevision,
              request.params.disposition,
              "agent",
            ),
          } satisfies Results["resolveChange"];
        }
        case "hello":
          if (request.params.protocolVersion !== PROTOCOL_VERSION)
            throw new MethodError(
              "protocol_version_mismatch",
              `this service speaks protocol ${PROTOCOL_VERSION}, and the client ${request.params.protocolVersion}; run \`archer stop\` and try again`,
              { protocolVersion: PROTOCOL_VERSION },
            );
          return {
            protocolVersion: PROTOCOL_VERSION,
            version: version(),
            homeUrl,
            serviceName,
          } satisfies Results["hello"];
        case "attach": {
          const root = findProject(request.params.root).root;
          // Every attach asks (ADR 0013), an already attached project too; a refusal does not detach it.
          const refused = admissionRefusal(root, admission);
          if (refused !== null) {
            if (refused.detail !== undefined)
              log(`[archer] attach refused: the global archer.toml could not be read: ${refused.detail}`);
            throw new MethodError("project_not_admitted", refused.message);
          }
          const existing = projects.get(root);
          if (existing !== undefined) return status(existing.state);
          if (projects.size + restoring.size >= maxProjects)
            throw new MethodError(
              "too_many_projects",
              `the service has ${maxProjects} projects attached, the most it keeps; detach one first`,
            );
          const state = await ProjectState.open(root, pageUrl, log, {
            store,
            restoreState,
            projectName,
            ...(options.now === undefined ? {} : { now: options.now }),
          });
          state.configureDiscovery(() => discoverySettings(state));
          // The state save on a turn of its own, after the reload's phases (O12).
          await new Promise<void>((done) => setImmediate(done));
          const again = projects.get(state.root);
          if (again !== undefined) {
            state.close();
            return status(again.state);
          }
          state.persist();
          store.markAttached(state.root, true);
          observeLifecycle(state, true);
          const watcher = watchProject(state);
          register(state.root, { state, watcher });
          watchThumbnails(state);
          artifactJobs.schedule(state.root);
          log(`[archer] service: attached ${state.root} at projects/${state.slug}/`);
          return status(state);
        }
        case "detach": {
          // A known root remains detachable after removal or a change in
          // surrounding manifests. Other inputs retain normal project discovery.
          const exactRoot = resolve(request.params.root);
          const key = projects.has(exactRoot) || restoring.has(exactRoot) ? exactRoot : projectKey(request.params.root);
          const found = key === null ? undefined : projects.get(key);
          if (key !== null && found === undefined && restoreFailures.delete(key)) {
            store.markAttached(key, false);
            return { detached: true };
          }
          // Still opening after a start: detached now and durably; the open, once done, is closed rather than registered.
          if (key !== null && found === undefined && restoring.has(key) && !restoreCancelled.has(key)) {
            store.markAttached(key, false);
            restoreCancelled.add(key);
            restoringStatus.delete(key);
            return { detached: true };
          }
          if (found === undefined || key === null) return { detached: false } satisfies Results["detach"];
          store.markAttached(key, false);
          projects.delete(key);
          telemetry?.forgetProject(found.state.root);
          found.watcher.close();
          found.state.close();
          endStreams(found.state);
          return { detached: true };
        }
        case "listProjects":
          // A saved project still opening is attached: it is listed, and its page says so until it opens.
          return {
            projects: [...[...projects.values()].map((p) => status(p.state)), ...restoringStatus.values()],
          } satisfies Results["listProjects"];
        case "issueAccess": {
          const issued = grants.issue(request.params.label);
          return {
            ...issued,
            url: `${transport.scheme}://${advertisedHost}:${port}/projects/?token=${issued.token}`,
          } satisfies Results["issueAccess"];
        }
        case "issueAuthoringAccess": {
          const roots = request.params.projectRoots.map((root) => findProject(root).root);
          if (new Set(roots).size !== roots.length)
            throw new MethodError(
              "invalid_params",
              "authoring access requires unique project roots after project discovery",
            );
          for (const root of roots)
            if (!projects.has(root))
              throw new MethodError(
                "project_not_attached",
                "attach every requested project before issuing authoring access",
              );
          // Mint a new base grant; never upgrade an existing browser credential.
          // No token receipt escapes if the separate entitlement commit fails.
          const issued = grants.issue(request.params.label);
          const entitlement = getAuthoringGrants().issue(issued.id, roots);
          return {
            ...issued,
            entitlementId: entitlement.entitlementId,
            projectRoots: entitlement.projectRoots,
            url: `${transport.scheme}://${advertisedHost}:${port}/projects/?token=${issued.token}`,
          } satisfies Results["issueAuthoringAccess"];
        }
        case "listAccess":
          return { grants: grants.list() } satisfies Results["listAccess"];
        case "issuePairingCode": {
          const issued = pairing.issue(configuredTransport.pairingCodeMinutes);
          const localOnly = host === "localhost" || isLoopback(unbracket(host));
          return {
            ...issued,
            url: `${transport.scheme}://${advertisedHost}:${port}/`,
            plainHttpOnNetwork: transport.scheme === "http" && !localOnly,
            localOnly,
          } satisfies Results["issuePairingCode"];
        }
        case "revokeAccess": {
          try {
            return { revoked: grants.revoke(request.params.grantId) } satisfies Results["revokeAccess"];
          } finally {
            // A rename may commit before a directory-sync failure is reported. Existing
            // streams must honor the disk's revoked/fail-closed state even without an ACK.
            if (!grants.isActive(request.params.grantId))
              for (const [response, id] of grantStreams) if (id === request.params.grantId) response.end();
          }
        }
        case "restartConfiguration":
          return {
            serviceName,
            stateDir,
            socketPath,
            host,
            port,
            restoreState,
            transport:
              transport.scheme === "http"
                ? { scheme: "http", forceHttp: transport.automatic !== true }
                : { scheme: "https", tlsCert: transportOptions.tlsCert!, tlsKey: transportOptions.tlsKey! },
            ...(options.pagePath === undefined ? {} : { pagePath: resolve(options.pagePath) }),
            servedPage: resolve(page),
            ...(retainedPage === undefined ? {} : { retainedPage }),
            launchEnv: Object.fromEntries(
              ["HOME", "XDG_CONFIG_HOME", "ARCHER_CONFIG", "ARCHER_OPEN_BROWSER"].flatMap((key) => {
                const value = (options.env ?? process.env)[key];
                return value === undefined ? [] : [[key, value]];
              }),
            ),
          } satisfies Results["restartConfiguration"];
        case "present": {
          const state = attached(request.params.root);
          await state.reload();
          const { presentationId, emphasis, exploration } = state.present(
            request.params.viewId,
            request.params.annotation,
            request.params.emphases,
            request.params.walkthrough,
            request.params.expand,
          );
          if (openBrowser && request.params.openBrowser !== false && !browserAttempted) {
            browserAttempted = true;
            try {
              await (options.browserOpener ?? launchBrowser)(state.url);
            } catch {
              log("[archer] browser: opener could not start; the diagram remains available at its UI URL");
            }
          }
          return {
            url: state.url,
            presentationId,
            ...(emphasis === undefined ? {} : { emphasis }),
            ...(exploration === undefined ? {} : { exploration }),
          } satisfies Results["present"];
        }
        case "setEmphasis": {
          const state = attached(request.params.root);
          state.setEmphasis(request.params.viewId, request.params.emphases);
          return {
            url: state.url,
            snapshot: state.emphasisPayload(request.params.viewId),
          } satisfies Results["setEmphasis"];
        }
        case "listEmphases":
          return attached(request.params.root).listEmphases(request.params.viewId) satisfies Results["listEmphases"];
        case "getContext": {
          const state = attached(request.params.root);
          if (reload) await state.reload();
          return state.context() satisfies Results["getContext"];
        }
        case "getModel": {
          const state = attached(request.params.root);
          if (reload) await state.reload();
          return state.modelSnapshot(request.params.viewId) satisfies Results["getModel"];
        }
        case "getProjectModel": {
          const state = attached(request.params.root);
          if (reload) await state.reload();
          return state.projectModelSnapshot() satisfies Results["getProjectModel"];
        }
        case "setSelection": {
          const state = attached(request.params.root);
          await state.reload();
          const outcome = state.postSelection(request.params.selection);
          if (!outcome.ok) throw new MethodError(outcome.code, outcome.message);
          return { selection: outcome.selection } satisfies Results["setSelection"];
        }
        case "recordWrite":
          attached(request.params.root).recordWrite(request.params.viewId, request.params.summary);
          return { recorded: true } satisfies Results["recordWrite"];
        case "stop":
          // Answered first, then stopped, so the caller hears back.
          setImmediate(() => void close());
          return { stopping: true } satisfies Results["stop"];
        case "registerAgent":
          return delivery.registerAgent(request.params) satisfies Results["registerAgent"];
        case "claimListener":
          return delivery.claimListener(request.params) satisfies Results["claimListener"];
        case "heartbeat":
          return delivery.heartbeat(request.params) satisfies Results["heartbeat"];
        case "waitMessage":
          return (await delivery.waitMessage(
            request.params,
            connection?.signal,
            connection?.afterWrite,
          )) satisfies Results["waitMessage"];
        case "inbox":
          return delivery.inbox(request.params, connection?.afterWrite) satisfies Results["inbox"];
        case "reportActivity":
          return delivery.reportActivity(request.params) satisfies Results["reportActivity"];
        case "listListeners":
          return delivery.listListeners(request.params) satisfies Results["listListeners"];
        case "mcpRelay":
          // The answer is the upgrade: socket.ts hands the connection to hostMcp once it is written.
          if (options.hostMcp === undefined)
            throw new MethodError("mcp_unavailable", "this service does not serve MCP over its socket");
          return { relaying: true } satisfies Results["mcpRelay"];
        case "handover":
          // As stop, telling every open page to reconnect at once: the replacement is warm and waiting.
          log("[archer] service: handing over to the replacement");
          setImmediate(() => void close(true));
          return { stopping: true } satisfies Results["handover"];
      }
    } catch (error) {
      if (error instanceof AuthoringStoreError)
        throw new MethodError(
          error.code,
          error.message,
          error.currentReviewRevision === undefined
            ? undefined
            : { currentReviewRevision: error.currentReviewRevision },
        );
      if (error instanceof PersistenceError) throw new MethodError(error.code, error.message);
      if (error instanceof StateRefusal) throw new MethodError(error.code, error.message, error.details);
      if (error instanceof WriteRuleDenied) {
        if (error.detail !== undefined)
          log(`[archer] write refused: the global archer.toml could not be read: ${error.detail}`);
        throw new MethodError(error.code, error.message, { rule: error.rule });
      }
      throw error;
    }
  };
}
