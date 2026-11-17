import type { CumulativeReviewDetail } from "../authoring/review-feed.ts";
import type { CumulativeReview } from "../authoring/store.ts";
import type { ReviewArtifactResult } from "../authoring/review-artifacts.ts";
// The management plane: how the CLI and the MCP server talk to the local
// Archer service. Written before either side so both can be built in
// parallel; change it only with both sides' tests.
//
// Transport: newline-delimited JSON over a Unix domain socket at
// `serviceSocketPath()` (a 0700 directory, owned by the user). One request per
// line, one response per line, matched by `id`. No token: the socket's file
// permissions are the authorization (single user per machine, ticket 07).
//
// The browser (data plane) is separate: HTTP on loopback by default, one
// service token in every URL, the copied Archer page served per project.

import type { DiagramEnvelope } from "../model/index.ts";
import type { ProjectModel } from "../project-model/merge.ts";
import type { EmphasisPayload } from "./emphasis.ts";
import type { SelectionContext } from "./selection.ts";
import type { AccessGrantInfo } from "./access-grants.ts";
import type { ChangeRecord } from "../changes/index.ts";
import type { ChangeDetail, PendingChangePage } from "../changes/review.ts";
import type { AgentMethod, AgentRequestParams, AgentResults } from "../agents/contract.ts";
import type { Expansion, ExplorationStamp } from "../../../shared/explorations.mts";
import type { ExplorationReport } from "../expand/exploration.ts";

export const PROTOCOL_VERSION = 1;
export { SERVICE_NAME_PATTERN } from "../service-name.ts";

/** A project the service has attached, by the canonical path of its root. */
export interface ProjectRef {
  readonly root: string;
}

export type Request =
  | {
      readonly id: number;
      readonly method: "readReview";
      readonly params: ProjectRef & { readonly reviewId: string; readonly part?: "baseline" | "latest" | "diff" };
    }
  | {
      readonly id: number;
      readonly method: "clearReview";
      readonly params: ProjectRef & {
        readonly reviewId: string;
        readonly expectedReviewRevision: number;
        readonly summary: string;
      };
    }
  | {
      readonly id: number;
      readonly method: "pendingChanges";
      readonly params: ProjectRef & { readonly limit?: number };
    }
  | {
      readonly id: number;
      readonly method: "listChanges";
      readonly params: ProjectRef & {
        readonly cursor?: string;
        readonly reviewCursor?: string;
        readonly limit?: number;
      };
    }
  | {
      readonly id: number;
      readonly method: "readChange";
      readonly params: ProjectRef & { readonly changeId: string; readonly part?: "before" | "after" };
    }
  | {
      readonly id: number;
      readonly method: "resolveChange";
      readonly params: ProjectRef & {
        readonly changeId: string;
        readonly expectedReviewRevision: number;
        readonly disposition: "handled" | "declined";
      };
    }
  | { readonly id: number; readonly method: "hello"; readonly params: { readonly protocolVersion: number } }
  | { readonly id: number; readonly method: "attach"; readonly params: ProjectRef }
  | { readonly id: number; readonly method: "detach"; readonly params: ProjectRef }
  | { readonly id: number; readonly method: "listProjects"; readonly params: Record<string, never> }
  | { readonly id: number; readonly method: "restartConfiguration"; readonly params: Record<string, never> }
  | { readonly id: number; readonly method: "issueAccess"; readonly params: { readonly label: string } }
  | {
      readonly id: number;
      readonly method: "issueAuthoringAccess";
      readonly params: { readonly label: string; readonly projectRoots: readonly string[] };
    }
  | { readonly id: number; readonly method: "listAccess"; readonly params: Record<string, never> }
  | { readonly id: number; readonly method: "revokeAccess"; readonly params: { readonly grantId: string } }
  | { readonly id: number; readonly method: "issuePairingCode"; readonly params: Record<string, never> }
  | {
      readonly id: number;
      readonly method: "present";
      /** `emphases`, set_emphasis payloads, are set in the same transaction as the presentation (present_diagram's emphasis). */
      readonly params: ProjectRef & {
        readonly viewId: string;
        readonly annotation?: string;
        readonly openBrowser?: boolean;
        readonly emphases?: readonly unknown[];
        readonly walkthrough?: { readonly id: string; readonly step: number };
        /** The agent's exploration (ADR 0036 §14, A11): checked whole, refused whole (`invalid_expand`). */
        readonly expand?: readonly Expansion[];
      };
    }
  | {
      readonly id: number;
      readonly method: "setEmphasis";
      /** `emphases` is the same JSON the `set_emphasis` tool takes (ADR 0005). */
      readonly params: ProjectRef & { readonly viewId: string; readonly emphases: readonly unknown[] };
    }
  | { readonly id: number; readonly method: "listEmphases"; readonly params: ProjectRef & { readonly viewId?: string } }
  | { readonly id: number; readonly method: "getContext"; readonly params: ProjectRef }
  | { readonly id: number; readonly method: "getModel"; readonly params: ProjectRef & { readonly viewId: string } }
  /** The project model the service keeps beside the compiled views (ADR 0036 §7, A2). */
  | { readonly id: number; readonly method: "getProjectModel"; readonly params: ProjectRef }
  | {
      readonly id: number;
      readonly method: "setSelection";
      readonly params: ProjectRef & { readonly selection: unknown };
    }
  | {
      readonly id: number;
      readonly method: "recordWrite";
      /**
       * Sent by the MCP server just before it writes a view's source (or
       * archer.toml for it): a recompile of that view within
       * AGENT_WRITE_WINDOW_MS is the agent's, with `summary`; any other is
       * the person's. Phase 3, the front door.
       */
      readonly params: ProjectRef & { readonly viewId: string; readonly summary?: string };
    }
  | { readonly id: number; readonly method: "stop"; readonly params: Record<string, never> }
  /** A stop for a warm replacement (ADR 0032): open pages are told to reconnect at once. */
  | { readonly id: number; readonly method: "handover"; readonly params: Record<string, never> }
  /** Agents, listeners, delivery and the MCP relay (ADR 0035; agents/contract.ts). `pinListener` is the page's alone. */
  | {
      readonly [M in SocketAgentMethod]: {
        readonly id: number;
        readonly method: M;
        readonly params: AgentRequestParams[M];
      };
    }[SocketAgentMethod];

/** The agent methods the management socket serves: all but the person's pick (AGENT_METHODS). */
export type SocketAgentMethod = Exclude<AgentMethod, "pinListener">;

export type Method = Request["method"];

/** How long after `recordWrite` a recompile of that view is still the agent's. */
export const AGENT_WRITE_WINDOW_MS = 5_000;
/** The most characters a write's summary ("merged Lexer into Parser") holds. */
export const MAX_SUMMARY_CHARS = 200;

export interface ProjectStatus {
  readonly root: string;
  /** archer.toml's name, else the git repository's (a worktree's main repository), else the folder's. */
  readonly name: string;
  /** The project's page, carrying the service token once: `http://<host>:<port>/projects/<name>/?follow&token=<token>`. */
  readonly url: string;
  /** The git repository the root checks out, when it does: a linked worktree carries its folder and branch. */
  readonly repository?: RepositoryStatus;
}

/** The same shape as `project/repository.ts`'s RepositoryIdentity (kept here so the page's types need not load it). */
export interface RepositoryStatus {
  readonly name: string;
  readonly commonDir: string;
  readonly worktree?: { readonly folder: string; readonly branch?: string };
}

export interface PresentationContext {
  readonly presentationId: string;
  readonly viewId: string;
  readonly revision: string;
  readonly annotation?: string;
  /** The walkthrough and step the agent opened the page on. */
  readonly walkthrough?: { readonly id: string; readonly step: number };
}

export interface Results extends AgentResults {
  readonly readReview: CumulativeReviewDetail & { readonly artifact?: ReviewArtifactResult };
  readonly clearReview: { readonly review: CumulativeReview; readonly artifact?: ReviewArtifactResult };
  readonly pendingChanges: PendingChangePage;
  readonly listChanges: PendingChangePage;
  readonly readChange: ChangeDetail;
  readonly resolveChange: { readonly record: ChangeRecord };
  readonly issueAccess: AccessGrantInfo & { readonly token: string; readonly url: string };
  readonly issueAuthoringAccess: AccessGrantInfo & {
    readonly token: string;
    readonly url: string;
    readonly entitlementId: string;
    readonly projectRoots: readonly string[];
  };
  readonly listAccess: { readonly grants: readonly AccessGrantInfo[] };
  readonly revokeAccess: { readonly revoked: boolean };
  /** A code typed at `url` (the base address, no secret). `plainHttpOnNetwork`: code and cookie cross the network unencrypted; `localOnly`: it listens on loopback only. */
  readonly issuePairingCode: {
    readonly code: string;
    readonly url: string;
    readonly minutes: number;
    readonly expiresAt: string;
    readonly plainHttpOnNetwork: boolean;
    readonly localOnly: boolean;
  };
  readonly hello: {
    readonly protocolVersion: number;
    readonly version: string;
    readonly homeUrl: string;
    readonly serviceName: string;
  };
  readonly attach: ProjectStatus;
  readonly detach: { readonly detached: boolean };
  readonly listProjects: { readonly projects: readonly ProjectStatus[] };
  readonly restartConfiguration: RestartConfiguration;
  /** `exploration` only when `expand` was sent and held: a service that predates it leaves it out. */
  readonly present: {
    readonly url: string;
    readonly presentationId: string;
    readonly emphasis?: EmphasisPayload;
    readonly exploration?: ExplorationStamp;
  };
  readonly setEmphasis: { readonly url: string; readonly snapshot?: EmphasisPayload };
  readonly listEmphases: { readonly schemaVersion: 1; readonly views: readonly EmphasisPayload[] };
  readonly getContext: {
    readonly presentation: PresentationContext | null;
    readonly selection: SelectionContext | null /** The walkthrough and step the reader's page shows. */;
    readonly walkthrough?: {
      readonly viewId: string;
      readonly id: string;
      readonly step: number;
    } | null /** The exploration on screen: the later of the agent's presented one and the reader's own (O1, A10). */;
    readonly exploration?: ExplorationReport;
  };
  readonly getModel: { readonly envelope: DiagramEnvelope | null };
  /** `generation` moves only when the model is rebuilt; `failing` names views whose source does not compile now. */
  readonly getProjectModel: {
    readonly model: ProjectModel;
    readonly generation: number;
    readonly failing: readonly string[];
  };
  readonly setSelection: { readonly selection: SelectionContext };
  readonly recordWrite: { readonly recorded: true };
  readonly stop: { readonly stopping: true };
  readonly handover: { readonly stopping: true };
}

/** Private launch settings; never exposed through browser routes or arbitrary environment forwarding. */
export interface RestartConfiguration {
  readonly serviceName: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly host: string;
  readonly port: number;
  readonly restoreState: boolean;
  /** HTTP: forceHttp true when asked for, false when automatic (a loopback bind with no TLS setting). */
  readonly transport?:
    | { readonly scheme: "http"; readonly forceHttp: boolean }
    | { readonly scheme: "https"; readonly tlsCert: string; readonly tlsKey: string };
  readonly pagePath?: string;
  /** The page this service serves, whether chosen or its default: a replacement keeps the assets it names (ADR 0032). */
  readonly servedPage?: string;
  /** The previous build's page whose assets this service still serves, if any; a same-build replacement keeps it. */
  readonly retainedPage?: string;
  readonly launchEnv: Readonly<
    Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "ARCHER_CONFIG" | "ARCHER_OPEN_BROWSER", string>>
  >;
}

export type Response =
  | { readonly id: number; readonly ok: true; readonly result: Results[Method] }
  | { readonly id: number; readonly ok: false; readonly error: ServiceError };

/** Errors reuse Archer's error vocabulary (ADR 0002): a code, a message, optional details. */
export interface ServiceError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
