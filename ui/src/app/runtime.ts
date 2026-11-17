import type { NetworkAccessState } from "./network-access";
import type { Bridge, BridgeCallbacks } from "./host-bridge";
import type { createHttpConnection, RecoveryStatus } from "./http-connection";
import type { StaticControls } from "../playground/webmcp-controls";
import type { TargetRef } from "../comments/contract";

/**
 * What a page runtime can offer, fixed by the runtime itself and known before anything loads. The service's own
 * negotiated features (comments, notes, listeners, instance settings) stay in `Capabilities`, read off the bootstrap.
 */
export interface RuntimeFeatures {
  /** New, Edit and the authoring workspace. */
  readonly authoring: boolean;
  /** The chat bubble and its project conversation. */
  readonly chat: boolean;
  /** Compare revisions and Export on the canvas tools. */
  readonly revisions: boolean;
  /** Comments are held as drafts and sent to the agent; without it a comment is saved where it is written. */
  readonly publishing: boolean;
  /** Search asks the service as well as the loaded listing. */
  readonly serverSearch: boolean;
  /** The project settings gear. */
  readonly projectSettings: boolean;
  /** The presence line's claims about changes on disk. */
  readonly diskChanges: boolean;
}

/** Copy that names what the runtime does with a comment. */
export interface RuntimeVocabulary {
  /** The composer's commit button. */
  readonly commitComment: string;
  /** A thread's status, when the runtime replaces the review status; null keeps the review status. */
  readonly threadStatus: { readonly label: string; readonly detail: string } | null;
}

/** One message of an example conversation. */
export interface ExampleMessage {
  readonly author: "person" | "agent";
  readonly body: string;
}

/**
 * What a runtime with no service shows on the surfaces a service would fill (the static Playground): the real
 * Archer Settings and the real chat, read-only, with the runtime's own example data and labelled as examples.
 * Absent from the live runtime, which has the service itself.
 */
export interface RuntimeExamples {
  /** Opens Archer Settings, whose values are the runtime's example `api/settings`. */
  readonly settingsNote: string;
  /** A scripted conversation about a document (`view:` or `note:`) or the whole project (`project:`), or null. */
  chat(projectSlug: string, target: TargetRef): readonly ExampleMessage[] | null;
  /** Stands where the chat's composer would be. */
  readonly chatNote: string;
  /** What Archer Settings says of network access, in place of a service's `api/connection` answer. */
  readonly networkAccess: NetworkAccessState;
}

/** I/O policy selected once by the page build. Live authentication and recovery stay in their own adapter. */
export interface PageRuntime {
  readonly features: RuntimeFeatures;
  readonly vocabulary: RuntimeVocabulary;
  /** Example settings and conversations, when the runtime has no service to ask (`features.chat` is then false). */
  readonly examples?: RuntimeExamples;
  request(url: string, init?: RequestInit): Promise<Response>;
  writable(status: string): boolean;
  /** Synchronous image consumers use public asset data instead of API image requests. */
  resourceUrl?: (url: string) => string | null;
  connect?: (callbacks: BridgeCallbacks) => Bridge;
  connection?: (onStatus: (status: RecoveryStatus) => void) => ReturnType<typeof createHttpConnection>;
  /** Optional local browser-tool action binding. Absent from live/MCP adapters. */
  bindControls?: (controls: StaticControls) => () => void;
}

export const LIVE_FEATURES: RuntimeFeatures = {
  authoring: true,
  chat: true,
  revisions: true,
  publishing: true,
  serverSearch: true,
  projectSettings: true,
  diskChanges: true,
};

/** The live adapter, unless an entry selects another one before it mounts the App (the static playground). */
export let runtime: PageRuntime = {
  features: LIVE_FEATURES,
  vocabulary: { commitComment: "Add comment", threadStatus: null },
  request: (url, init) => fetch(url, init),
  writable: (status) => status === "connected",
};

/** Called once by an entry before it renders; every consumer reads `runtime` at call time. */
export function selectPageRuntime(next: PageRuntime): void {
  runtime = next;
}
