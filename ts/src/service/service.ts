import {
  materializeReview,
  type ReviewArtifactOptions,
  type ReviewArtifactResult,
} from "../authoring/review-artifacts.ts";
import { AuthoringPresentationStore } from "../authoring/presentation-store.ts";
import { parsePresentationRequest } from "../../../shared/authoring-presentation.mts";
import { EDITING_DISABLED, withSourceWriterLock } from "../project/source-writer.ts";
import { AuthoringCoordinator } from "../authoring/coordinator.ts";
import { AuthoringStore, AuthoringStoreError } from "../authoring/store.ts";
import { previewAuthoring } from "../authoring/preview.ts";
import { AuthoringInputError, parseAuthoringRequest } from "../../../shared/authoring-contract.mts";
import { resolveFeedbackConfiguration } from "../config/feedback-resolution.ts";
import { AccountStateStore, PersistenceError } from "../state/account.ts";
import { ChangeStore, ChangeStoreError } from "../changes/index.ts";
// The local Archer service (ticket 07): one per user, started on first need,
// stopped with `archer stop`. It serves every attached project's page over
// HTTP on loopback, under one token, and answers the CLI and MCP front doors
// on a Unix socket (protocol.ts). Private account recovery retains attachments
// and verified runtime context across stops without rewriting project files.
import { chmodSync, existsSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { loadGlobalConfiguration } from "../config/load.ts";
import { deliveryPolicy } from "../config/agents.ts";
import { resolveServiceConfiguration } from "../config/resolve.ts";
import { loopbackBind, prepareTransport, type TransportOptions } from "./transport.ts";
import { accessRefusalText } from "./access-fix.ts";
import { readNetworkAccessRecord } from "./network-access-record.ts";
import { createWebServer, http2Requested, type WebServer } from "./web-server.ts";
import type { ServerResponse, RequestListener } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../bin/main.ts";
import { findProject } from "../project/index.ts";
import { withApplicationVersion } from "./page-version.ts";
import type { PageAsset } from "./page-assets.ts";
import { PageServing } from "./page-serving.ts";
export { withApplicationVersion };
import { handleRequest, isLoopback, KEEP_ALIVE_MS, adoptPageCopies, preparePage, type DataPlane } from "./http.ts";
import { browserConnection } from "./browser-protocol.ts";
import {
  checkSocketPath,
  ensureServiceDir,
  readIdentity,
  serviceDirs,
  socketProblem,
  StateError,
  writeIdentity,
  type Env,
} from "./paths.ts";
import { ProjectState } from "./project-state.ts";
import {
  PROTOCOL_VERSION,
  SERVICE_NAME_PATTERN,
  type Method,
  type ProjectStatus,
  type Request,
  type Results,
} from "./protocol.ts";
import { MethodError, serveConnection, type ConnectionContext, type ConnectionControl } from "./socket.ts";
import { Delivery } from "./listeners.ts";
import { launchEnvironment, launchInput, launchPlan, startLauncher } from "./launcher.ts";
import type { HostMcp } from "../mcp/host-contract.ts";
import { StreamCap } from "./streams.ts";
import { newToken } from "./token.ts";
import { AccessGrantStore } from "./access-grants.ts";
import { PairingAttemptFile, PairingCodes } from "./pairing-codes.ts";
import { ProjectNameStore, slugBase } from "../state/project-names.ts";
import { projectDisplayName } from "../project/repository.ts";
import { AuthoringGrantError, AuthoringGrantStore } from "./authoring-grants.ts";
import { resolveDiscoverySettings } from "../project/discovery.ts";
import { createApplication } from "../application/index.ts";
import { connectService, ServiceCallError, type ServiceClient } from "./service-client.ts";
import { shouldOpenBrowser } from "./browser.ts";
import { ProjectWatcher } from "./watch.ts";
import { drawingIdentity, ThumbnailPainters, ThumbnailStore } from "./thumbnails.ts";
import { WARM_SOURCES, warmCompilers } from "../mermaid/warm.ts";
import { compile } from "../mermaid/index.ts";
import { compileInThisThread } from "../mermaid/compile.ts";
import { writeFileSync } from "node:fs";
import { useCompilePool } from "./compile-pool.ts";
import { releaseLock as releaseServiceLock, takeLock } from "./lock.ts";
import { instanceKind, registerInstance, type Registration } from "./instances.ts";
import { ownerToken } from "../comments/lock.ts";
import { exportFontFaces, installationAsset } from "../assets.ts";
import { InstanceSettingsStore } from "../config/instance-settings.ts";
import {
  admissionRefusal,
  assertWriteAllowed,
  browserEditing,
  configureWritePolicy,
  WriteRuleDenied,
} from "../config/write-policy.ts";
import {
  ProjectLifecycleStore,
  type ProjectLifecycleMetadata,
  type ProjectVisibility,
} from "../state/project-lifecycle.ts";
import {
  activate,
  deactivate,
  debugEnabled,
  knowSecret,
  phaseEnd,
  phaseStart,
  profilingEnabled,
  Telemetry,
} from "../telemetry/index.ts";
import { DebugHttp } from "./debug-http.ts";
import { lazyStore } from "./lazy-store.ts";
import { ArtifactJobs } from "./artifact-jobs.ts";
import { createManagementHandler } from "./management.ts";
import { explainSandbox } from "./sandbox.ts";

/** How many projects one service attaches at once; each costs watchers and compiled models. */
export const MAX_PROJECTS = 64;
/** Saved attachments opened at once after a start. */
const RESTORE_CONCURRENCY = 4;
/** How long a request naming a project still being opened waits before it answers project_loading. */
export const RESTORE_WAIT_MS = 3_000;
/** Bounded opportunity to finish admitted HTTP reads/writes before forcing closure. */
export const HTTP_DRAIN_MS = 5_000;
/** How long a hand-over waits for relayed MCP calls under way; well inside the replacement's wait (15 s). */
export const RELAY_DRAIN_MS = 5_000;
/**
 * How long a stop keeps a relay whose calls are under way, after the service has let go of its socket, port
 * and locks: a relayed call that stopped this service (setup_network_access restarting Archer onto another
 * bind) starts the replacement, checks it and answers in that time (ensureService waits up to 15 s).
 */
export const RELAY_STOP_DRAIN_MS = 30_000;

export interface ServiceOptions extends TransportOptions {
  /** Where XDG paths and HOME are read from; the process's own by default. */
  readonly env?: Env;
  /** Identity reported on the management socket; `default` otherwise. */
  readonly serviceName?: string;
  /** Overrides the state directory (token and port). */
  readonly stateDir?: string;
  /** Overrides the management socket's path. */
  readonly socketPath?: string;
  /** The HTTP listener's address; loopback by default. */
  readonly host?: string;
  /** Overrides the configured HTTP port; zero explicitly requests an ephemeral port.
   * With neither option nor configuration, reuse the last port or choose a free one. */
  readonly port?: number;
  /**
   * The page of the build this service took over from (`archer restart`, ADR 0032): the assets it names are
   * served too, for tabs loaded before the hand-over. ARCHER_HANDOVER_PREVIOUS_PAGE.
   */
  readonly previousPagePath?: string;
  /**
   * The previous build's page that the service handing over still served (ARCHER_HANDOVER_RETAINED_PAGE): kept
   * when `previousPagePath` is this service's own page (a same-build restart), so one previous build stays served.
   */
  readonly retainedPagePath?: string;
  /** The page to serve; the copy in ts/assets by default. */
  readonly pagePath?: string;
  readonly log?: (line: string) => void;
  /** Opt-in native watcher/reload diagnostics; not a wire capability or setting. */
  readonly watchTrace?: (line: string) => void;
  readonly browserOpener?: (url: string) => Promise<void>;
  /** Recover previously attached projects and valid runtime context. */
  readonly restoreState?: boolean;
  /** Lifecycle deadline clock, in milliseconds; Date.now by default. */
  readonly now?: () => number;
  /** Draw thumbnails in the background when a view's model revision is new; true by default. */
  readonly prefetchThumbnails?: boolean;
  /**
   * Before taking requests, load Mermaid's parsers (mermaid/warm.ts) and start a thumbnail painter,
   * and draw missing thumbnails within a moment of a change rather than after two quiet seconds.
   * True by default; tests that start many services turn it off.
   */
  readonly warmStart?: boolean;
  /**
   * Compile in worker threads, each compile within a budget (compile-pool.ts), so no source holds
   * the event loop. Follows warmStart by default.
   */
  readonly compileInWorkers?: boolean;
  /** One compile's budget in the workers; COMPILE_BUDGET_MS by default. For tests. */
  readonly compileBudgetMs?: number;
  /**
   * An isolated instance (ADR 0031) stops after this long with no client, stream or request;
   * ARCHER_IDLE_TIMEOUT_MS, else DEFAULT_IDLE_TIMEOUT_MS. Zero never stops. The main one never does.
   */
  readonly idleTimeoutMs?: number;
  /** How often the service checks its state directory and idleness; for tests. */
  readonly housekeepingMs?: number;
  /**
   * A warm hand-over (ADR 0032): warm the compilers first, write `readyPath`, then wait up to
   * `waitMs` for the running service to release its locks, and take its place.
   */
  readonly handover?: { readonly readyPath: string; readonly waitMs: number };
  /**
   * Serves MCP for relays (ADR 0035 §6): a connection that answers `mcpRelay` carries MCP JSON-RPC lines
   * to it. Without it `mcpRelay` is refused (`mcp_unavailable`).
   */
  readonly hostMcp?: HostMcp;
}

/** Sent to every open stream before a hand-over ends it: reconnect at once, the replacement is coming. */
export const HANDOVER_RETRY_MS = 250;

/** An isolated instance's idle stop: half an hour with no client, stream or request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const HOUSEKEEPING_MS = 5_000;

/** Whether a project root no longer exists (removed, or a parent removed); other failures are not "gone". */
function rootGone(root: string): boolean {
  try {
    lstatSync(root);
    return false;
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** With warmStart: background drawing starts this soon after a change, and looks again this soon after finding a request drawing. */
const WARM_BACKGROUND_DELAY_MS = 150;
const WARM_BUSY_RETRY_MS = 50;

export interface RunningService {
  readonly token: string;
  readonly port: number;
  readonly homeUrl: string;
  readonly socketPath: string;
  readonly stateDir: string;
  /** Internal save-coordinator storage; no browser or management capability is implied. */
  readonly changes: ChangeStore;
  /** Stops serving: ends every stream, closes the socket and the listener. Idempotent. */
  close(): Promise<void>;
  /** Resolves once the service has stopped, by `stop` or `close`. */
  readonly closed: Promise<void>;
}

export class ServiceRunningError extends Error {
  override readonly name = "ServiceRunningError";
}

/** Background review-artifact refresh: lock wait per attempt, retry delay and attempts per review. */
export { ARTIFACT_LOCK_WAIT_MS, ARTIFACT_RETRIES, ARTIFACT_RETRY_MS } from "./artifact-jobs.ts";

/**
 * The web page the service serves: the bundle's (`assets/archer-ui.html` beside its chunks), or in a checkout
 * this checkout's page build (`ui/dist/index.html`, with its own files beside it). Never the MCP App's single
 * file, which carries the MCP shell alone. In a checkout without a page build this names the build's path all
 * the same, so a request for the page fails naming the file, and `startService` logs how to build it.
 */
export function defaultPagePath(): string {
  const candidates = ["../assets/archer-ui.html", "./assets/archer-ui.html", "../../../ui/dist/index.html"].map((p) =>
    fileURLToPath(new URL(p, import.meta.url)),
  );
  return candidates.find((p) => existsSync(p)) ?? (candidates[2] as string);
}

export async function startService(options: ServiceOptions = {}): Promise<RunningService> {
  const serviceName = options.serviceName ?? "default";
  if (!SERVICE_NAME_PATTERN.test(serviceName))
    throw new PersistenceError("invalid_configuration", "service name must match ^[a-z0-9][a-z0-9-]{0,31}$");
  const configured = (options.env ?? process.env)["ARCHER_RESTORE_STATE"];
  if (options.restoreState === undefined && configured !== undefined && configured !== "true" && configured !== "false")
    throw new PersistenceError("invalid_configuration", "ARCHER_RESTORE_STATE must be true or false");
  const http2 = http2Requested(options.env ?? process.env);
  // Which thumbnail format pages are told to ask for (the inventory's `thumbnailFormat`); only that format is drawn.
  // PNG by default: labels keep their face and weight (the packaged Fira Sans) and a gallery shows sooner than with SVGs, each of
  // which the browser parses on the main thread.
  const thumbnailFormat = (options.env ?? process.env)["ARCHER_THUMBNAIL_FORMAT"] ?? "png";
  if (thumbnailFormat !== "svg" && thumbnailFormat !== "png")
    throw new PersistenceError("invalid_configuration", "ARCHER_THUMBNAIL_FORMAT must be svg or png");
  const global = loadGlobalConfiguration(options.env ?? process.env);
  const configuredTransport = resolveServiceConfiguration({
    projectRoot: resolve("/"),
    ...global,
    env: options.env ?? process.env,
    flags: { serviceName },
  }).settings;
  const host = options.host ?? configuredTransport.host;
  const wildcardBind = host === "0.0.0.0" || host === "::";
  const transportOptions: TransportOptions = {
    ...(configuredTransport.tlsCert === undefined ? {} : { tlsCert: configuredTransport.tlsCert }),
    ...(configuredTransport.tlsKey === undefined ? {} : { tlsKey: configuredTransport.tlsKey }),
    forceHttp: configuredTransport.forceHttp ?? false,
    ...(options.forceHttp === undefined ? {} : { forceHttp: options.forceHttp }),
    ...(options.tlsCert === undefined ? {} : { tlsCert: options.tlsCert }),
    ...(options.tlsKey === undefined ? {} : { tlsKey: options.tlsKey }),
  };
  // A wildcard bind advertises the host its certificate was made for (`archer tls setup --host X`), so
  // a name or any of the machine's addresses works; without one, the machine's first LAN address.
  const transport = prepareTransport(transportOptions, wildcardBind ? host : unbracket(urlHost(host)));
  const certificateHost = transport.scheme === "https" && wildcardBind ? transport.certificateHost : undefined;
  const advertisedHost = certificateHost === undefined ? urlHost(host) : urlHost(certificateHost);
  if (wildcardBind && transport.scheme === "https" && certificateHost === undefined)
    prepareTransport(transportOptions, unbracket(advertisedHost));
  const restoreState = options.restoreState ?? configured !== "false";
  const idleSetting = (options.env ?? process.env)["ARCHER_IDLE_TIMEOUT_MS"];
  if (
    options.idleTimeoutMs === undefined &&
    idleSetting !== undefined &&
    idleSetting !== "" &&
    !/^\d{1,10}$/.test(idleSetting)
  )
    throw new PersistenceError(
      "invalid_configuration",
      "ARCHER_IDLE_TIMEOUT_MS must be a whole number of milliseconds (0 never stops)",
    );
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (idleSetting === undefined || idleSetting === "" ? DEFAULT_IDLE_TIMEOUT_MS : Number(idleSetting));
  // ADR 0013 admission mode; a running service keeps its startup settings. Rules are read per attach.
  const admission = configuredTransport.admission;
  const openBrowser = shouldOpenBrowser(options.env ?? process.env);
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const dirs = serviceDirs(options.env ?? process.env);
  const stateDir = resolve(options.stateDir ?? dirs.stateDir);
  const socketPath = resolve(
    options.socketPath ?? (options.stateDir === undefined ? dirs.socketPath : join(stateDir, "archer.sock")),
  );
  // R4: Archer's own default directory is created 0700 (an older loose one tightened); one the person named is refused when loose.
  ensureServiceDir(stateDir, options.env ?? process.env, "the state directory");
  ensureServiceDir(dirname(socketPath), options.env ?? process.env, "the socket's directory");

  // Lock the saved identity as well as the socket. An explicit alternate
  // socket must not let a second daemon rotate this identity's token/port.
  const locks = [...new Set([join(stateDir, "archer.lock"), join(dirname(socketPath), "archer.lock")])];
  const held: string[] = [];
  const releaseLock = (): void => {
    for (const lock of held.splice(0).reverse()) releaseServiceLock(lock);
  };

  let startupHttp: WebServer | undefined;
  // Its worker threads keep the process alive: a failed start must close them, or it never exits.
  let startupPainters: ThumbnailPainters | undefined;
  let endWritePolicy = (): void => {};
  // Like the painters' workers: released on a failed start as on close.
  let compilers: { stop(): void; release(): void } = { stop: () => {}, release: () => {} };
  // Development telemetry (docs/devkit/service-telemetry.md): built only when ARCHER_DEBUG=1.
  const telemetry = debugEnabled(options.env ?? process.env) ? new Telemetry({ sink: log }) : null;
  if (telemetry !== null) {
    telemetry.start();
    activate(telemetry);
  }
  const stopTelemetry = (): void => {
    if (telemetry !== null) {
      telemetry.stop();
      deactivate(telemetry);
    }
  };
  let holding: NodeJS.Timeout | undefined;
  try {
    const page = options.pagePath ?? defaultPagePath();
    if (options.pagePath === undefined && !existsSync(page))
      log(`[archer] ui: page=missing path=${page} fix="build the page with \`npm run build\`"`);
    // The page and its own files, read on first need; with one previous build's (page-serving.ts).
    const pages = new PageServing({
      path: page,
      previousPagePath: options.previousPagePath,
      retainedPagePath: options.retainedPagePath,
      version,
    });
    const pageBuffer = (): Buffer => pages.page();
    const retainedPage = pages.retainedPage;
    const pageAsset = (name: string): PageAsset | null => pages.asset(name);
    const handover = options.handover;
    let poolStarted = false;
    // Nothing else holds the event loop until the listeners open (the compile workers are unref'd).
    if (handover !== undefined) holding = setInterval(() => {}, 1_000);
    if (handover !== undefined) {
      // Everything that does not touch the state directory, before the running service is asked to go.
      if (options.warmStart !== false) {
        // The workers load Mermaid on their own threads while this one does (O30): one after the
        // other, a heavily loaded host spent most of restart's 15 s getting here; side by side, about half.
        let workersWarm: Promise<unknown> = Promise.resolve();
        if (options.compileInWorkers ?? true) {
          compilers = useCompilePool(
            options.compileBudgetMs === undefined ? {} : { budgetMs: options.compileBudgetMs },
          );
          poolStarted = true;
          workersWarm = Promise.all(
            Object.values(WARM_SOURCES).map((source) => compile(source).catch(() => undefined)),
          );
        }
        const ms = await warmCompilers(compileInThisThread);
        await workersWarm;
        log(`[archer] service: compilers loaded in ${Math.round(ms)} ms`);
        // The first reader after the swap gets a compressed page: gzip is ready before the old service is asked to go.
        try {
          await preparePage(pageBuffer());
        } catch {
          /* an unreadable page is reported when it is served */
        }
      }
      writeFileSync(handover.readyPath, `${process.pid}\n`, { mode: 0o600 });
      log("[archer] service: warm; waiting for the running service to hand over");
    }
    const handoverDeadline = handover === undefined ? 0 : Date.now() + handover.waitMs;
    for (const lock of locks) {
      for (;;) {
        try {
          takeLock(
            lock,
            (pid) => new ServiceRunningError(`an Archer service is already running (process ${pid}, lock ${lock})`),
            () => new ServiceRunningError(`another Archer service took the lock ${lock} while this one was starting`),
          );
          break;
        } catch (error) {
          if (!(error instanceof ServiceRunningError) || Date.now() >= handoverDeadline) throw error;
          await new Promise((done) => setTimeout(done, 5));
        }
      }
      held.push(lock);
    }
    clearInterval(holding);
    const store = new AccountStateStore(stateDir);
    const lifecycle = new ProjectLifecycleStore(stateDir, options.now);
    const grants = new AccessGrantStore(stateDir);
    // Codes are in memory only: a restart or hot swap (ADR 0032) voids every code; the agent issues
    // another. The tries spent are persisted in the state directory, so a restart is no fresh budget (R1).
    const pairing = new PairingCodes({ store: new PairingAttemptFile(stateDir) });
    const names = new ProjectNameStore(stateDir);
    const projectName = (root: string): string => names.nameFor(root, slugBase(root));
    // A socket another account planted (or a file) is neither deferred to nor removed (R4, C-26).
    const planted = socketProblem(socketPath, { stale: "remove" });
    if (planted !== undefined) throw new StateError(planted);
    if (await answers(socketPath))
      throw new ServiceRunningError(`an Archer service is already running on ${socketPath}`);
    removeIfPresent(socketPath);

    const saved = readIdentity(stateDir);
    const projects = new Map<string, { state: ProjectState; watcher: ProjectWatcher }>();
    /**
     * Registers an open project, keeping `projects` in the account index's order (the order projects were first
     * attached), so every listing (the overview, listProjects) is the same before and after a restart. A start opens
     * saved projects in parallel lanes; the map's insertion order was the order they finished opening, and a restart
     * moved a big project from first to last on the overview (O97).
     */
    const register = (root: string, entry: { state: ProjectState; watcher: ProjectWatcher }): void => {
      projects.set(root, entry);
      const rank = new Map(store.attachedRoots().map((r, i) => [r, i]));
      const at = (r: string): number => rank.get(r) ?? Number.MAX_SAFE_INTEGER;
      const keys = [...projects.keys()];
      const sorted = [...keys].sort((a, b) => at(a) - at(b));
      if (sorted.every((r, i) => keys[i] === r)) return;
      const entries = sorted.map((r) => [r, projects.get(r)!] as const);
      projects.clear();
      for (const [r, e] of entries) projects.set(r, e);
    };
    /** Saved attachments still being opened after a start, by root. */
    const restoring = new Map<string, Promise<void>>();
    const restoreDone = new Map<string, () => void>();
    const restoringStatus = new Map<string, ProjectStatus>();
    /** Roots detached while they were still opening: their open is closed, not registered. */
    const restoreCancelled = new Set<string>();
    /** The background restore's lanes: a stop waits for them before it releases the compile workers. */
    const restoreLanes: Promise<void>[] = [];
    /** Saved attachments that could not be opened (invalid saved state): each refuses requests until detached. */
    const restoreFailures = new Map<string, { code: string; message: string }>();
    /** Waits up to `ms` for these restores; true when none is left. */
    const restored = async (roots: readonly string[], ms: number): Promise<boolean> => {
      const pending = roots.flatMap((root) => {
        const wait = restoring.get(root);
        return wait === undefined ? [] : [wait];
      });
      if (pending.length === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((done) => {
          timer = setTimeout(done, ms);
        }),
      ]);
      clearTimeout(timer);
      return roots.every((root) => !restoring.has(root));
    };
    /** A project by its name. */
    const named = (slug: string): ProjectState | undefined =>
      [...projects.values()].find((p) => p.state.slug === slug)?.state;
    const streams = new Map<ServerResponse, ProjectState>();
    const grantStreams = new Map<ServerResponse, string>();
    // Agents and listeners per checkout (ADR 0035): in memory, but for the person's pins.
    const delivery = new Delivery({
      stateDir,
      projects: () => [...projects.values()].map((p) => p.state),
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...((options.env ?? process.env)["HOME"] === undefined ? {} : { home: (options.env ?? process.env)["HOME"]! }),
      launcherSet: () => {
        try {
          return (loadGlobalConfiguration(options.env ?? process.env).user.agents?.launcher?.length ?? 0) > 0;
        } catch {
          return false;
        }
      },
      // The delivery order (ADR 0035, amended 2026-10-31), read fresh at each decision: the person's own file, then
      // the project's archer.toml, which only narrows it. Either unreadable throws, and nothing starts.
      policy: (state) => {
        let real = state.root;
        try {
          real = realpathSync(state.root);
        } catch {
          /* the root as attached */
        }
        return deliveryPolicy(
          loadGlobalConfiguration(options.env ?? process.env).user,
          findProject(state.root),
          state.root,
          real,
        );
      },
      // Read at each press: the person may set the launcher without restarting Archer. Their file only.
      launch: (state, message) => {
        const plan = launchPlan(loadGlobalConfiguration(options.env ?? process.env).user, state.root);
        return startLauncher(
          plan,
          launchEnvironment(process.env, state.root, message),
          launchInput(state.root, message),
        );
      },
    });
    /**
     * Management connections serving an MCP relay. A stop ends them at once; a hand-over first lets the
     * calls they already took finish (review decision 8), within RELAY_DRAIN_MS, then ends them, so each
     * relay reconnects to the replacement.
     */
    const relays = new Map<Socket, ConnectionControl>();
    const discoverySettings = (state: ProjectState) =>
      resolveDiscoverySettings(state.project, {
        system: global.system?.discovery ?? {},
        user: global.user.discovery ?? {},
      });
    const observeLifecycle = (state: ProjectState, automaticEligible: boolean): ProjectLifecycleMetadata =>
      lifecycle.observe(state.root, state.lifecycleContent(discoverySettings(state)), automaticEligible);
    const watchProject = (state: ProjectState): ProjectWatcher => {
      const trace = options.watchTrace;
      const watcher = new ProjectWatcher(
        state.root,
        state.project.folder,
        () => {
          trace?.(`[archer] watcher trace: reload:start root=${JSON.stringify(state.root)}`);
          void state
            .reload()
            .then(() => {
              trace?.(`[archer] watcher trace: reload:settled root=${JSON.stringify(state.root)}`);
              try {
                observeLifecycle(state, false);
              } catch (failure) {
                log(
                  `[archer] lifecycle observation failed for ${state.root}: ${failure instanceof Error ? failure.message : String(failure)}`,
                );
              }
              watcher.sync(state.project.folder, state.discoveryWatchDirectories(discoverySettings(state)));
            })
            .catch((error) => {
              trace?.(`[archer] watcher trace: reload:rejected root=${JSON.stringify(state.root)}`);
              log(`[archer] watcher reload failed: ${String(error)}`);
            });
        },
        state.discoveryWatchDirectories(discoverySettings(state)),
        {
          log,
          ...(trace === undefined ? {} : { trace }),
          // A file event makes the state's memoized reads stale at once, not after the quiet period's reload.
          onEvent: () => state.forgetReads(),
        },
      );
      return watcher;
    };
    const admitted = new Set<ServerResponse>();
    /** When a client, stream or request was last seen (ADR 0031's idle stop). */
    let lastActive = Date.now();
    const touch = (): void => {
      lastActive = Date.now();
    };
    const drained = new Set<() => void>();
    let managementActive = 0;
    const managementDrained = new Set<() => void>();
    let stopping = false;
    const assertAuthoringGrantsOwner = (): void => {
      if (stopping)
        throw new AuthoringGrantError(
          "service_stopping",
          "the service no longer admits authoring entitlement operations",
        );
    };
    const authoringGrants = lazyStore(() => new AuthoringGrantStore(stateDir, assertAuthoringGrantsOwner), {
      assertOpen: assertAuthoringGrantsOwner,
      wrap: (failure) =>
        failure instanceof AuthoringGrantError
          ? failure
          : new AuthoringGrantError("invalid_authoring_store", "authoring entitlement store is unavailable"),
    });
    const getAuthoringGrants = (): AuthoringGrantStore => authoringGrants.get();
    const assertChangeOwner = (): void => {
      if (stopping)
        throw new ChangeStoreError("change_store_closed", "the service no longer admits change-store operations");
    };
    const changes = lazyStore(
      () =>
        new ChangeStore({
          stateDir,
          serviceName,
          assertOwner: assertChangeOwner,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      {
        assertOpen: assertChangeOwner,
        wrap: (failure) =>
          failure instanceof ChangeStoreError
            ? failure
            : new ChangeStoreError(
                "change_store_unavailable",
                "the document change store could not be opened; restart after recovery",
              ),
      },
    );
    const getChanges = (): ChangeStore => changes.get();
    const assertSavedAuthoringOwner = (): void => {
      if (stopping)
        throw new AuthoringStoreError("authoring_store_closed", "the service no longer admits authoring operations");
    };
    const savedAuthoring = lazyStore(
      () =>
        new AuthoringStore({
          stateDir,
          serviceName,
          assertOwner: assertSavedAuthoringOwner,
          ...(options.now ? { now: options.now } : {}),
        }),
      {
        assertOpen: assertSavedAuthoringOwner,
        wrap: (failure) =>
          failure instanceof AuthoringStoreError
            ? failure
            : new AuthoringStoreError("authoring_store_unavailable", "saved authoring work is unavailable"),
      },
    );
    const getSavedAuthoring = (): AuthoringStore => savedAuthoring.get();
    // Derived files never decide whether a source write or clear committed.
    const reviewArtifact = (
      root: string,
      reviewId: string,
      artifactOptions?: ReviewArtifactOptions,
    ): ReviewArtifactResult => {
      try {
        return materializeReview(findProject(root), getSavedAuthoring(), reviewId, artifactOptions);
      } catch {
        return { status: "unavailable", message: "Review is saved; its derived diff file could not be refreshed." };
      }
    };
    const artifactJobs = new ArtifactJobs({
      stateDir,
      saved: savedAuthoring,
      refresh: reviewArtifact,
      hasProject: (root) => projects.has(root),
      isStopping: () => stopping,
    });
    // Checks stopping only inside the store's own operations; a failure to open is kept as it was thrown.
    const presentations = lazyStore(
      () =>
        new AuthoringPresentationStore({
          stateDir,
          serviceName,
          assertOwner: () => {
            if (stopping) throw new AuthoringStoreError("authoring_store_closed", "the service is stopping");
          },
        }),
      {},
    );
    const getPresentations = (): AuthoringPresentationStore => presentations.get();
    let activeAuthoringCompiles = 0;
    // Assigned once the port is held, before any request can be read.
    let plane: DataPlane | null = null;
    // Drawn in worker threads; the theme is read once, when the first starts, from the installation (never the project).
    const painters = new ThumbnailPainters({
      themeCss: () => installationAsset("export/theme.css").toString("utf8"),
      // Only the format pages are told to use is drawn: drawing both made the startup pre-draw ~46 % slower.
      ...(thumbnailFormat === "png"
        ? {
            raster: () => ({
              fontFaces: exportFontFaces(),
              wasmBytes: installationAsset("export/index_bg.wasm"),
            }),
          }
        : {}),
    });
    startupPainters = painters;
    const warmStart = options.warmStart !== false;
    const thumbnails = new ThumbnailStore({
      dir: join(stateDir, "cache", "thumbnails"),
      // The format is part of the painter, so switching it never serves the other format's cached refusal.
      // The drawing's own identity, not Archer's version: an upgrade that leaves drawing alone keeps the cache (ADR 0032).
      painter: drawingIdentity(
        thumbnailFormat,
        (() => {
          // An installation missing an asset fails its drawings, as before, not the start; its cache is keyed by version.
          try {
            return [
              installationAsset("export/theme.css"),
              ...(thumbnailFormat === "png"
                ? [...exportFontFaces().map((face) => face.bytes), installationAsset("export/index_bg.wasm")]
                : []),
            ];
          } catch {
            return [Buffer.from(version())];
          }
        })(),
      ),
      // No page request or management call in flight (open event streams do not count). A drawing in a
      // worker thread takes a core but not the event loop, so with warmStart it does not wait for pages;
      // requests for thumbnails still go first (the store waits while one draws or waits).
      idle: () => (warmStart && painters.threaded) || (admitted.size <= streams.size && managementActive === 0),
      ...(warmStart ? { backgroundDelayMs: WARM_BACKGROUND_DELAY_MS, busyRetryMs: WARM_BUSY_RETRY_MS } : {}),
      render: painters.render,
      format: thumbnailFormat,
    });
    /** Draws each view's thumbnails in the background when its model revision is new, so a gallery finds them ready. */
    const prefetchThumbnails = (
      state: ProjectState,
      views: readonly { readonly id: string; readonly modelRevision?: string }[],
    ): void => {
      thumbnails.prefetch(
        views
          .flatMap((view) => {
            const revision = view.modelRevision;
            if (revision === undefined) return [];
            const envelope = () => {
              const current = state.envelope(view.id);
              return current?.revision === revision ? current : null;
            };
            return (["light", "dark"] as const).map((theme) => ({
              request: { viewId: view.id, revision, theme },
              envelope,
            }));
            // Every light drawing before any dark one: a gallery asks for one theme, so half the work readies it.
          })
          .sort((a, b) => (a.request.theme === b.request.theme ? 0 : a.request.theme === "light" ? -1 : 1)),
      );
    };
    const watchThumbnails = (state: ProjectState): void => {
      if (options.prefetchThumbnails === false) return;
      state.subscribe((event, payload) => {
        if (event === "inventory")
          prefetchThumbnails(state, (payload as { views: { id: string; modelRevision?: string }[] }).views);
      });
      prefetchThumbnails(state, state.inventory().views);
    };
    const dispatch: RequestListener = (req, res) => {
      if (plane === null) return void res.writeHead(503).end();
      if (stopping) {
        // Authentication still precedes the shutdown refusal: unknown tokens
        // keep their bare 404, including while admitted requests drain.
        return handleRequest(plane, req, res);
      }
      admitted.add(res);
      touch();
      const finished = (): void => {
        admitted.delete(res);
        touch();
        if (admitted.size === 0) for (const done of drained) done();
      };
      res.once("finish", finished);
      res.once("close", finished);
      handleRequest(plane, req, res);
    };
    const debugHttp =
      telemetry === null
        ? null
        : new DebugHttp({
            telemetry,
            version: version(),
            profiling: profilingEnabled(options.env ?? process.env),
            authority: () => plane?.authority,
            projects: () =>
              [...projects.values()].map(({ state, watcher }) => ({
                slug: state.slug,
                root: state.root,
                loaded: true,
                watcher: watcher.watching,
              })),
            streams: () => streams.size,
          });
    const handler: RequestListener = debugHttp === null ? dispatch : (req, res) => debugHttp.handle(req, res, dispatch);
    const http = createWebServer(transport, handler, http2);
    if (http2 && transport.scheme === "http")
      log("[archer] service: ARCHER_HTTP2 applies to TLS only; serving HTTP/1.1");
    if (transport.scheme === "http" && wildcardBind)
      log(
        `[archer] service: warning: plain HTTP on every interface (${host}); links carry their token in the clear on the network. Use HTTPS (setup_network_access, or archer network-access in a terminal) or bind 127.0.0.1.`,
      );
    startupHttp = http;
    const remembered = saved?.port ?? 0;
    const configuredPort = options.port ?? configuredTransport.port;
    if (warmStart) {
      // Mermaid's first load holds the event loop for about a second: pay it before any request can wait on it.
      if (handover === undefined) {
        const ms = await warmCompilers();
        log(`[archer] service: compilers loaded in ${Math.round(ms)} ms`);
      }
      // Read and verify the page (a few tens of ms of sync work) before the loop-delay baseline is dropped, so it is not counted.
      try {
        void preparePage(pageBuffer());
      } catch {
        /* an unreadable page is reported when it is served */
      }
      telemetry?.discardLoopDelay();
      if (options.prefetchThumbnails !== false) painters.warm();
    }
    if ((options.compileInWorkers ?? warmStart) && !poolStarted)
      compilers = useCompilePool(options.compileBudgetMs === undefined ? {} : { budgetMs: options.compileBudgetMs });
    const port = await listenHttp(http, host, configuredPort ?? remembered, configuredPort === undefined);
    // Plain HTTP nobody asked for is only for an address no other device can reach: a name such as
    // localhost is held to the address it actually bound (an altered hosts file cannot widen it).
    if (transport.scheme === "http" && transport.automatic === true) {
      const bound = http.address();
      if (bound === null || typeof bound === "string" || !isLoopback(bound.address))
        throw new PersistenceError(
          "tls_required",
          accessRefusalText(
            "tls_required",
            `Archer's host ${host} bound ${typeof bound === "object" && bound !== null ? bound.address : "an unknown address"}, which other devices can reach, and serves that only over HTTPS.`,
          ),
        );
    }
    const actualOrigin = new URL(`${transport.scheme}://${advertisedHost}:${port}/`).origin;
    // Open to the network (setup_network_access, or a hand-written network bind): said in the log and on the page.
    const networkRecord = readNetworkAccessRecord(stateDir);
    const networkAccess = loopbackBind(host)
      ? undefined
      : {
          address: `${actualOrigin}/`,
          since:
            networkRecord?.enabled === true && networkRecord.bind === unbracket(host)
              ? networkRecord.since
              : new Date().toISOString(),
        };
    if (networkAccess !== undefined)
      log(
        `[archer] service: open to the network at ${networkAccess.address} (bound to ${host}) since ${networkAccess.since}; turn off with setup_network_access enabled: false, or archer network-access off`,
      );
    if (configuredTransport.publicUrl !== undefined && new URL(configuredTransport.publicUrl).origin !== actualOrigin)
      throw new PersistenceError(
        "invalid_configuration",
        "public_url must match the native listener origin; proxy termination is not implemented",
      );
    // The token is kept only at the port it was handed out with. A tab left
    // open on the old URL may already have sent it to whatever holds that
    // port now, so a service that cannot take its old port back issues a new
    // token as well as a new port.
    const token = saved !== null && saved.port === port ? saved.token : newToken();
    if (saved !== null && saved.token !== token)
      log(`[archer] service: port ${saved.port} was taken; serving on ${port} with a new token`);
    writeIdentity(stateDir, { token, port });
    // Telemetry hides this token cut short or re-encoded, not only whole (C-34): it knows it until the stop.
    const forgetToken = knowSecret("token", token);
    plane = {
      authority: {
        serviceToken: token,
        grants,
        secure: transport.scheme === "https",
        cookieName: `${transport.scheme === "https" ? "__Host-" : ""}archer-${port}`,
        allowedHosts: new Set(
          [
            advertisedHost,
            "localhost",
            "127.0.0.1",
            "[::1]",
            ...(host === "0.0.0.0" || host === "::" ? [] : [host]),
          ].map((name) => `${name.toLowerCase()}:${port}`),
        ),
      },
      grantStreams,
      pairing,
      authoring: {
        // Any admitted browser link may edit (decided 2026-10-28): `edit` decides, read fresh at each write
        // (browserEditing). An entitlement issued for this root is still named in the journal when there is one.
        entitlement: (grantId, root) => {
          try {
            return getAuthoringGrants().entitlement(grantId, root) ?? { entitlementId: `link:${grantId}` };
          } catch {
            return { entitlementId: `link:${grantId}` };
          }
        },
        request: async (admission, action, input) => {
          const needsCompile =
            action === "mutate" || action === "preview" || action === "edit" || action === "presentation";
          if (needsCompile && activeAuthoringCompiles >= 2)
            throw Object.assign(new Error("at most two authoring requests may compile concurrently"), {
              code: "authoring_busy",
            });
          if (needsCompile) activeAuthoringCompiles++;
          try {
            const currentProject = () => {
              if (stopping || !projects.has(admission.root))
                throw new AuthoringStoreError("authoring_project_unavailable", "the project is no longer attached");
              const project = findProject(admission.root);
              if (project.root !== admission.root)
                throw new AuthoringStoreError("authoring_authority_changed", "the project root changed");
              return project;
            };
            // Server-Timing (S9): the grant and project checks are `project`; the store's reads `store`.
            const checking = phaseStart();
            admission.authority();
            currentProject();
            phaseEnd("project", checking);
            // `edit = false` (ADR 0028): refuse editor writes before any store is opened or input weighed.
            const writes =
              action === "mutate" ||
              (action === "presentation" &&
                !(typeof input === "object" && input !== null && (input as { op?: unknown }).op === "read"));
            if (writes && !browserEditing(currentProject()).enabled)
              throw Object.assign(new Error(EDITING_DISABLED), { code: "editing_disabled" });
            if (action === "preview" || action === "edit") return await previewAuthoring(input, action === "edit");
            const opening = phaseStart();
            const coordinator = new AuthoringCoordinator({
              store: getSavedAuthoring(),
              changes: getChanges(),
              project: currentProject,
              authority: admission.authority,
              feedback: (project) => {
                const fresh = loadGlobalConfiguration(options.env ?? process.env);
                const policy = resolveFeedbackConfiguration({ ...fresh, project, serviceName });
                return { changes: policy.changes, delivery: policy.delivery, effectiveRevision: policy.revision };
              },
            });
            phaseEnd("store", opening);
            if (action === "presentation") {
              const request = parsePresentationRequest(input),
                opened = coordinator.open(request.target);
              const conflict = (message: string): never => {
                throw new AuthoringStoreError("authoring_presentation_conflict", message);
              };
              if (
                opened.targetRevision !== request.expectedTargetRevision ||
                (request.sourceRevision !== undefined && opened.sourceRevision !== request.sourceRevision)
              )
                conflict("the source or its target mapping changed");
              const nodeIds = async (): Promise<Set<string> | null> => {
                const model = (await coordinator.compile(opened.source)).envelope?.model;
                return model ? new Set<string>("nodes" in model ? model.nodes.map((node) => node.id) : []) : null;
              };
              if (request.op === "read") {
                // A saved layout outlives source edits made elsewhere (an agent, a revert): leave out
                // positions for nodes the source no longer has. The revision stays the stored one, the
                // compare-and-set token for the next save. An uncompilable source returns the layout as saved.
                const saved = getPresentations().get(admission.root, opened.targetRevision);
                const live = saved && Object.keys(saved.positions).length > 0 ? await nodeIds() : null;
                if (!saved || !live) return { presentation: saved };
                return {
                  presentation: {
                    ...saved,
                    positions: Object.fromEntries(Object.entries(saved.positions).filter(([id]) => live.has(id))),
                  },
                };
              }
              const ids = await nodeIds();
              if (!ids) throw new AuthoringInputError("layout requires valid diagram source");
              if (Object.keys(request.positions).some((id) => !ids.has(id)))
                throw new AuthoringInputError("layout contains a node outside this diagram");
              const project = currentProject();
              return withSourceWriterLock(project, opened.authoringPath, () => {
                admission.authority();
                // A layout save is an editor action: none while archer.toml says `edit = false` (ADR 0028).
                if (!browserEditing(findProject(admission.root)).enabled)
                  throw Object.assign(new Error(EDITING_DISABLED), { code: "editing_disabled" });
                // And the target's write rule: a diagram file needs `diagrams`, a block in a note `notes` (ADR 0028).
                assertWriteAllowed(admission.root, opened.blockId === null ? "diagrams" : "notes");
                const current = coordinator.open(request.target);
                if (
                  current.targetRevision !== request.expectedTargetRevision ||
                  current.sourceRevision !== request.sourceRevision
                )
                  conflict("the source or its target mapping changed");
                return {
                  presentation: getPresentations().put({
                    projectRoot: admission.root,
                    targetRevision: current.targetRevision,
                    sourceRevision: current.sourceRevision,
                    expectedRevision: request.expectedRevision,
                    positions: request.positions,
                  }),
                };
              });
            }
            if (action === "mutate") {
              if (parseAuthoringRequest(input).journalGeneration === undefined)
                throw new AuthoringStoreError(
                  "authoring_generation_required",
                  "Open the authoring workspace before saving; this request has no journal generation.",
                );
              const receipt = await coordinator.mutate(input);
              if (receipt.review?.reviewId) {
                try {
                  return {
                    ...receipt,
                    artifact: materializeReview(currentProject(), getSavedAuthoring(), receipt.review.reviewId),
                  };
                } catch {
                  return {
                    ...receipt,
                    artifact: {
                      status: "unavailable",
                      message: "The diagram and review are saved; the diff file is unavailable.",
                    },
                  };
                }
              }
              return receipt;
            }
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new AuthoringInputError("invalid authoring request");
            const fields = input as Record<string, unknown>;
            const keys = Object.keys(fields);
            if (action === "status") {
              if (
                keys.some((key) => key !== "offset") ||
                (fields.offset !== undefined &&
                  (typeof fields.offset !== "string" || !/^(?:0|[1-9][0-9]{0,4})$/u.test(fields.offset)))
              )
                throw new AuthoringInputError("invalid status offset");
              const reading = phaseStart();
              const status = coordinator.status(100, fields.offset === undefined ? 0 : Number(fields.offset));
              phaseEnd("store", reading);
              return status;
            }
            if (action === "operation") {
              if (
                keys.length !== 1 ||
                typeof fields.operationId !== "string" ||
                !/^[a-f0-9]{32}$/u.test(fields.operationId)
              )
                throw new AuthoringInputError("invalid operation ID");
              const reading = phaseStart();
              const operation = coordinator.operation(fields.operationId);
              phaseEnd("store", reading);
              return { operation };
            }
            if (action === "open") {
              if (keys.length !== 1 || !Object.hasOwn(fields, "target"))
                throw new AuthoringInputError("invalid open target");
              const reading = phaseStart();
              const opened = coordinator.open(fields.target);
              phaseEnd("store", reading);
              return opened;
            }
            if (action === "snapshot") {
              if (
                keys.length !== 2 ||
                typeof fields.draftId !== "string" ||
                !/^drf_[a-f0-9]{32}$/u.test(fields.draftId) ||
                !Number.isSafeInteger(fields.draftRevision) ||
                Number(fields.draftRevision) < 1
              )
                throw new AuthoringInputError("invalid saved revision");
              const reading = phaseStart();
              const snapshot = coordinator.snapshot(fields.draftId, Number(fields.draftRevision));
              phaseEnd("store", reading);
              return snapshot;
            }
            throw new AuthoringInputError("unknown authoring action");
          } catch (error) {
            // The page gets fixed text; the configuration's diagnostic goes to this log only.
            if (error instanceof WriteRuleDenied && error.detail !== undefined)
              log(`[archer] write refused: the global archer.toml could not be read: ${error.detail}`);
            throw error;
          } finally {
            if (needsCompile) activeAuthoringCompiles--;
          }
        },
      },
      discoverySettings,
      connection: browserConnection(version(), KEEP_ALIVE_MS, networkAccess),
      isStopping: () => stopping,
      isRestoring: () => restoring.size > 0,
      operation: async (root, name, args) => {
        const service = async (): Promise<ServiceClient> => pageClient();
        const application = createApplication({ cwd: root, ensureService: service, findService: service });
        try {
          return await application.call(name, args);
        } finally {
          application.close();
        }
      },
      page: pageBuffer,
      pageAsset: (name) => {
        const asset = pageAsset(name);
        if (asset !== null && asset.packaged !== null)
          adoptPageCopies(asset.bytes, asset.packaged.gzip, asset.packaged.br);
        return asset?.bytes ?? null;
      },
      project: (slug) => named(slug),
      projects: () => [...projects.values()].map((p) => p.state),
      projectLifecycle: (state) => observeLifecycle(state, false),
      setProjectLifecycle: (slug: string, visibility: ProjectVisibility) => {
        const state = named(slug);
        if (state === undefined) return null;
        const content = state.lifecycleContent(discoverySettings(state));
        lifecycle.observe(state.root, content, false);
        return lifecycle.setVisibility(state.root, visibility, content);
      },
      cap: new StreamCap(),
      log,
      streams,
      settings: new InstanceSettingsStore(serviceName, options.env ?? process.env, undefined, undefined, {
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.forceHttp === undefined ? {} : { forceHttp: options.forceHttp }),
        ...(options.tlsCert === undefined ? {} : { tlsCert: options.tlsCert }),
        ...(options.tlsKey === undefined ? {} : { tlsKey: options.tlsKey }),
      }),
      projectFeedback: (state) =>
        resolveFeedbackConfiguration({
          ...(global.system === undefined ? {} : { system: global.system }),
          user: global.user,
          project: state.project,
          serviceName,
        }),
      thumbnails,
      listeners: {
        listing: (state, view) => delivery.listing(state, view),
        pin: (state, agentId) => delivery.pin(state, agentId),
        launch: (state, threadId) => delivery.launch(state, threadId),
        arrived: (state, threadIds, sender) => delivery.arrived(state, threadIds, sender),
      },
    };
    /**
     * The management client of a page operation (export, comparison). Its reads of
     * the served model and context answer from this service's state without the
     * reload a front door's read forces: the watcher keeps that state current, and
     * the operation compiles the file itself. Everything else goes over the socket.
     */
    const pageClient = (): ServiceClient => {
      let remote: Promise<ServiceClient> | undefined;
      const call = async (method: Method, params: Request["params"]): Promise<unknown> => {
        if (method !== "getModel" && method !== "getContext")
          return (await (remote ??= connectService(socketPath))).call(method as never, params as never);
        try {
          return await handle({ id: 0, method, params } as Request, false);
        } catch (failure) {
          throw failure instanceof MethodError ? new ServiceCallError(failure.toWire()) : failure;
        }
      };
      return {
        call: call as ServiceClient["call"],
        close: () => {
          void remote?.then(
            (client) => client.close(),
            () => undefined,
          );
        },
      };
    };
    // Agent-facing: clean addresses carrying the service token once. The page exchanges it for the
    // access cookie and lands on the same address without it (ADR 0017): Projects, or a project's follow page.
    const homeUrl = `${transport.scheme}://${advertisedHost}:${port}/projects/?token=${token}`;
    const pageUrl = (slug: string): string =>
      `${transport.scheme}://${advertisedHost}:${port}/projects/${slug}/?follow&token=${token}`;

    const status = (state: ProjectState): ProjectStatus => ({
      root: state.root,
      name: state.name,
      url: state.url,
      ...(state.repository === null ? {} : { repository: state.repository }),
    });
    const attached = (root: string): ProjectState => {
      const key = projectKey(root);
      const found = key === null ? undefined : projects.get(key);
      if (found === undefined)
        throw new MethodError("project_not_attached", `no project is attached at ${root}; attach it first`);
      return found.state;
    };
    const endStreams = (state?: ProjectState): void => {
      for (const [res, owner] of streams) if (state === undefined || owner === state) res.end();
    };
    let resolveClosed = (): void => {};
    const closed = new Promise<void>((ok) => (resolveClosed = ok));
    let management: NetServer | null = null;
    const connections = new Set<Socket>();
    let registration: Registration | undefined;
    let housekeeping: NodeJS.Timeout | undefined;
    /** The socket file this service bound: a replacement's at the same path is never removed. */
    let socketIdentity: string | undefined;

    // The account rules (ADR 0013) come from this service's environment while it runs. A process
    // runs one service; services started together in one process share the latest environment.
    endWritePolicy = configureWritePolicy({ env: options.env ?? process.env });
    let drainingRelays = false;
    const close = async (handingOver = false): Promise<void> => {
      if (stopping || drainingRelays) return closed;
      if (handingOver && relays.size > 0) {
        // Before `stopping`: a relayed call still under way reaches this service through its own socket.
        drainingRelays = true;
        const started = Date.now();
        await Promise.all([...relays.values()].map((control) => control.drainRelay(RELAY_DRAIN_MS)));
        log(`[archer] service: relayed MCP calls drained in ${Date.now() - started} ms`);
      }
      stopping = true;
      // Held waits and relays never hold the drain (ADR 0035, ADR 0032): a hand-over tells each wait to call
      // the replacement and each relay to reconnect; a stop refuses the waits.
      const heldWaits = delivery.openWaits;
      if (handingOver) delivery.handOver();
      else delivery.stop();
      // A plain stop ends every relay at once, except one with calls under way (PD-2): that call may be the
      // one that asked for the stop, and it answers through this relay. It takes no new calls ("not run"),
      // and ends once answered, after this service has let go of everything a replacement needs (below).
      const lingering = new Map<Socket, Promise<void>>();
      for (const [socket, control] of relays) {
        if (!handingOver && control.relayBusy()) lingering.set(socket, control.drainRelay(RELAY_STOP_DRAIN_MS, "stop"));
        else socket.end();
      }
      // Each answer is written on its connection before anything below can end the connections.
      if (heldWaits > 0) await new Promise<void>((done) => setImmediate(done));
      // A hand-over: every page reconnects at once, to the replacement, rather than backing off (ADR 0032).
      if (handingOver)
        for (const res of streams.keys())
          if (!res.writableEnded)
            res.write(`retry: ${HANDOVER_RETRY_MS}\nevent: reconnect\ndata: {"reason":"handover"}\n\n`);
      endStreams();
      if (admitted.size > 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            drained.delete(done);
            resolve();
          };
          const timer = setTimeout(() => {
            if (admitted.size > 0)
              log(
                `[archer] service: drain deadline reached with ${admitted.size} HTTP responses outstanding; interrupted write outcomes may be unknown`,
              );
            done();
          }, HTTP_DRAIN_MS);
          drained.add(done);
          if (admitted.size === 0) done();
        });
      }
      if (managementActive > 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            managementDrained.delete(done);
            resolve();
          };
          const timer = setTimeout(() => {
            // Releasing the writer lock while an async attach/present can
            // still persist would permit two writers. Stay stopping until it
            // finishes; the CLI has its own bounded, actionable deadline.
            log(
              `[archer] service: management drain deadline reached with ${managementActive} operations outstanding; retaining writer ownership until they finish`,
            );
          }, HTTP_DRAIN_MS);
          managementDrained.add(done);
          if (managementActive === 0) done();
        });
      }
      for (const { state, watcher } of projects.values()) {
        watcher.close();
        state.close();
      }
      projects.clear();
      thumbnails.close();
      painters.close();
      // An open still under way fails at its next compile (stopping, it is closed, not registered); the
      // pool is released only after, so no compile of it falls back to this thread.
      compilers.stop();
      await Promise.all(restoreLanes);
      compilers.release();
      // A socket file at our path that is not ours belongs to a replacement (our state directory was
      // replaced): closing the listener would unlink it (libuv removes the bound path), so it is only released.
      let ours = true;
      try {
        ours = socketIdentity === undefined || fileIdentity(socketPath) === socketIdentity;
      } catch {
        ours = false;
      }
      await Promise.all([
        new Promise<void>((ok) => {
          if (management === null) return ok();
          const others = [...connections].filter((socket) => !lingering.has(socket));
          if (!ours) {
            management.unref();
            for (const socket of others) socket.destroy();
            return ok();
          }
          if (lingering.size === 0) management.close(() => ok());
          else {
            // The listener goes now (its path with it); the lingering relays end after the release below.
            management.close();
            let open = others.length;
            if (open === 0) ok();
            for (const socket of others)
              socket.once("close", () => {
                if (--open === 0) ok();
              });
          }
          // Every reply already written is flushed before the connection ends.
          for (const socket of others) socket.end();
        }),
        new Promise<void>((ok) => {
          http.close(() => ok());
          http.closeAllConnections();
        }),
      ]);
      if (ours) removeIfPresent(socketPath);
      clearInterval(housekeeping);
      registration?.remove();
      releaseLock();
      stopTelemetry();
      forgetToken();
      endWritePolicy();
      if (lingering.size > 0) {
        log(
          `[archer] service: released; waiting for ${lingering.size} relayed MCP call${lingering.size === 1 ? "" : "s"} under way to answer`,
        );
        await Promise.all(lingering.values());
        for (const socket of lingering.keys()) socket.end();
      }
      log("[archer] service: stopped");
      resolveClosed();
    };

    /** A request naming a project still being opened waits a moment for it, then answers project_loading. */
    const awaitRestore = async (request: Request): Promise<void> => {
      const root = (request.params as { root?: unknown } | undefined)?.root;
      if (typeof root !== "string" || request.method === "detach") return;
      const key = projectKey(root);
      if (key === null) return;
      if (restoring.has(key) && !restoreCancelled.has(key) && !(await restored([key], RESTORE_WAIT_MS)))
        throw new MethodError(
          "project_loading",
          `Archer is still opening the project at ${key} after starting; try again in a few seconds`,
        );
      const failed = restoreFailures.get(key);
      if (failed !== undefined)
        throw new MethodError(failed.code, `${failed.message}; detach the project to clear its saved state`);
    };

    // The management methods (management.ts): every input is the service's own, read as each request is answered.
    const answer = createManagementHandler({
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
      maxProjects: MAX_PROJECTS,
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
    });
    /** `reload` false: a read answers from the served state (pageClient). */
    const handle = async (
      request: Request,
      reload = true,
      connection?: ConnectionContext,
    ): Promise<Results[Method]> => {
      if (stopping) throw new MethodError("service_stopping", "the service is stopping");
      // A held wait is not an operation in flight: a stop or hand-over answers it rather than waiting for it.
      const tracked = request.method !== "stop" && request.method !== "handover" && request.method !== "waitMessage";
      if (tracked) managementActive++;
      touch();
      try {
        if (restoring.size > 0 || restoreFailures.size > 0) await awaitRestore(request);
        return await answer(request, reload, connection);
      } finally {
        if (tracked && --managementActive === 0) {
          // Let serveConnection enqueue the resolved handler's reply before
          // the drain continuation ends management sockets.
          setImmediate(() => {
            if (managementActive === 0) for (const done of managementDrained) done();
          });
        }
      }
    };

    // Saved attachments are checked now, and opened after the socket answers (server review S2): opening
    // compiles every diagram, and a client gives a starting service 15 s to answer `hello`. Until a
    // project is open, requests naming it wait a moment, then answer `project_loading`.
    const toRestore: string[] = [];
    if (restoreState) {
      for (const root of store.attachedRoots()) {
        if (toRestore.length >= MAX_PROJECTS)
          throw new PersistenceError("saved_state_capacity", "saved attachments exceed the active project limit");
        // A root that is gone (a deleted scratch worktree) is detached for good, not retried on every start.
        if (rootGone(root)) {
          store.markAttached(root, false);
          log(`[archer] recovery: detached ${root}: its folder is gone`);
          continue;
        }
        let found: ReturnType<typeof findProject>;
        try {
          found = findProject(root);
        } catch (e) {
          log(`[archer] recovery: project_not_found ${root}: ${String(e)}`);
          continue;
        }
        const canonical = found.root;
        if (canonical !== root)
          throw new PersistenceError("invalid_saved_state", "saved project root has been rebound");
        if (store.load(root) === null)
          throw new PersistenceError("invalid_saved_state", "attached project recovery metadata is missing");
        const refused = admissionRefusal(root, admission);
        if (refused !== null) {
          log(`[archer] recovery: ${root} is not admitted and was detached: ${refused.detail ?? refused.message}`);
          store.markAttached(root, false);
          continue;
        }
        toRestore.push(root);
        restoring.set(root, new Promise<void>((done) => restoreDone.set(root, done)));
        // Listed while it opens, as ProjectState will name it: the page shows "opening" until then.
        restoringStatus.set(root, { root, name: projectDisplayName(found), url: pageUrl(projectName(root)) });
      }
    }
    const restoreOne = async (root: string): Promise<void> => {
      try {
        const state = await ProjectState.open(root, pageUrl, log, {
          store,
          restoreState,
          projectName,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (stopping || restoreCancelled.has(root)) {
          state.close();
          return;
        }
        state.configureDiscovery(() => discoverySettings(state));
        observeLifecycle(state, false);
        const watcher = watchProject(state);
        register(state.root, { state, watcher });
        watchThumbnails(state);
        artifactJobs.schedule(state.root);
      } catch (failure) {
        if (stopping || restoreCancelled.has(root)) return;
        // Fail closed for this project: its saved state is kept, and requests naming it are refused until it is detached.
        const message = failure instanceof Error ? failure.message : String(failure);
        restoreFailures.set(root, {
          code: failure instanceof PersistenceError ? failure.code : "project_restore_failed",
          message,
        });
        log(`[archer] recovery: ${root} could not be opened: ${message}`);
      }
    };
    const startRestore = (): void => {
      const queue = [...toRestore];
      const next = async (): Promise<void> => {
        // A stop takes no further roots; the open under way finishes in the compile workers, within their budget.
        for (let root = queue.shift(); root !== undefined && !stopping; root = queue.shift()) {
          await restoreOne(root);
          restoring.delete(root);
          restoringStatus.delete(root);
          restoreCancelled.delete(root);
          restoreDone.get(root)?.();
          restoreDone.delete(root);
        }
      };
      for (let lane = 0; lane < RESTORE_CONCURRENCY; lane++) restoreLanes.push(next());
    };
    management = await listenSocket(socketPath, (socket) => {
      connections.add(socket);
      touch();
      socket.on("close", () => {
        connections.delete(socket);
        touch();
      });
      const hostMcp = options.hostMcp;
      const control: ConnectionControl = serveConnection(
        socket,
        (request, context) => handle(request, true, context),
        log,
        hostMcp === undefined
          ? {}
          : {
              relay: async (endpoint, launch) => {
                relays.set(socket, control);
                try {
                  await hostMcp(endpoint, launch);
                } finally {
                  relays.delete(socket);
                }
              },
            },
      );
    });
    socketIdentity = fileIdentity(socketPath);
    // ADR 0031: listed in the person's registry while serving; stops itself when abandoned.
    const env = options.env ?? process.env;
    const kind = instanceKind(stateDir, env);
    const owner = ownerToken(process.pid);
    let idleSince: number | null = null;
    try {
      if (typeof owner === "string")
        registration = registerInstance(env, {
          pid: process.pid,
          owner,
          version: version(),
          protocolVersion: PROTOCOL_VERSION,
          serviceName,
          stateDir,
          socketPath,
          url: `${new URL(homeUrl).origin}/`,
          kind,
          startedAt: new Date().toISOString(),
          idleSince: null,
        });
    } catch (failure) {
      log(
        `[archer] service: not listed in the instance registry: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
    const stateIdentity = statSync(stateDir).ino;
    const stateDirGone = (): boolean => {
      try {
        return statSync(stateDir).ino !== stateIdentity;
      } catch {
        return true;
      }
    };
    const busy = (): boolean =>
      connections.size > 0 || admitted.size > 0 || managementActive > 0 || streams.size > 0 || grantStreams.size > 0;
    const housekeepingMs =
      options.housekeepingMs ??
      (idleTimeoutMs > 0 ? Math.max(50, Math.min(HOUSEKEEPING_MS, Math.floor(idleTimeoutMs / 4))) : HOUSEKEEPING_MS);
    housekeeping = setInterval(() => {
      if (stopping) return;
      if (stateDirGone()) {
        log(`[archer] service: the state directory ${stateDir} is gone; stopping`);
        void close();
        return;
      }
      // An attached project whose folder is gone is detached, durably; its private state stays, as for any detach.
      for (const [root, found] of [...projects]) {
        if (!rootGone(root)) continue;
        try {
          store.markAttached(root, false);
        } catch (failure) {
          log(
            `[archer] service: could not detach ${root}, whose folder is gone: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          continue;
        }
        projects.delete(root);
        telemetry?.forgetProject(found.state.root);
        found.watcher.close();
        found.state.close();
        endStreams(found.state);
        log(`[archer] service: detached ${root}: its folder is gone`);
      }
      const since = busy() ? null : lastActive;
      if (since !== idleSince) {
        idleSince = since;
        registration?.update({ idleSince: since === null ? null : new Date(since).toISOString() });
      }
      if (kind === "isolated" && idleTimeoutMs > 0 && since !== null && Date.now() - since >= idleTimeoutMs) {
        log(`[archer] service: isolated and idle for ${Math.round((Date.now() - since) / 1000)} s; stopping`);
        void close();
      }
    }, housekeepingMs);
    housekeeping.unref();
    log(`[archer] service: serving ${homeUrl.replace(token, "<token>")} and ${socketPath}`);
    startRestore();
    return {
      token,
      port,
      homeUrl,
      socketPath,
      stateDir,
      close: () => close(),
      closed,
      get changes() {
        return getChanges();
      },
    };
  } catch (error) {
    clearInterval(holding);
    if (startupHttp !== undefined)
      await new Promise<void>((resolve) => {
        startupHttp!.close(() => resolve());
        startupHttp!.closeAllConnections();
      });
    startupPainters?.close();
    compilers.release();
    releaseLock();
    stopTelemetry();
    endWritePolicy();
    throw error;
  }
}

/** The key a root is attached under: the root of the project it is in. */
function projectKey(root: string): string | null {
  try {
    return findProject(root).root;
  } catch {
    return null;
  }
}

/** Whether a live service answers on the socket. */
function answers(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((ok) => {
    const socket = connect(socketPath);
    const done = (alive: boolean): void => {
      socket.destroy();
      ok(alive);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A file's identity: its inode and change time, as a reused inode number gets a new change time. */
function fileIdentity(path: string): string {
  const stats = lstatSync(path, { bigint: true });
  return `${stats.dev}:${stats.ino}:${stats.ctimeNs}`;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // not there
  }
}

/** Listens on `port`; if that one is taken and it was only remembered, on any free one. */
async function listenHttp(server: NetServer, host: string, port: number, fallBack: boolean): Promise<number> {
  const listen = (p: number): Promise<void> =>
    new Promise((ok, fail) => {
      server.once("error", (error: Error) => fail(explainSandbox(error)));
      server.listen(p, host, () => {
        server.off("error", fail);
        ok();
      });
    });
  try {
    await listen(port);
  } catch (error) {
    if (!fallBack || port === 0) throw error;
    await listen(0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the HTTP listener has no port");
  return address.port;
}

function listenSocket(path: string, onConnection: (socket: Socket) => void): Promise<NetServer> {
  const server = createNetServer(onConnection);
  return new Promise((ok, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        error.code === "EADDRINUSE"
          ? new ServiceRunningError(`an Archer service is already running on ${path}`)
          : explainSandbox(error),
      ),
    );
    checkSocketPath(path);
    // The 0700 directory is the barrier; the socket is also the owner's alone (0600), whatever the
    // umask gave it (C-36). A socket that cannot be narrowed is not served.
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        server.close();
        return fail(error);
      }
      ok(server);
    });
  });
}

function unbracket(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/** A wildcard bind is not an address anyone can open; name the machine's own. */
function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a !== undefined && a.family === "IPv4" && !a.internal);
    return lan?.address ?? "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}
