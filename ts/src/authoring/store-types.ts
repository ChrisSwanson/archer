/** Private service-owned domain records. These are not browser request/permission types. */
export interface SnapshotRef {
  readonly revision: string;
  readonly bytes: number;
}
export type DraftOrigin =
  | {
      readonly kind: "new";
      readonly proposedPath?: string;
    }
  | {
      readonly kind: "document";
      readonly path: string;
      readonly blockId?: string;
      readonly baseSourceRevision: string;
      readonly base: SnapshotRef;
    };
export interface SavedRevision {
  readonly draftRevision: number;
  readonly source: SnapshotRef;
  readonly savedAt: string;
  readonly valid: boolean;
  readonly intent?: string;
}
export interface SavedDraft {
  readonly draftId: string;
  readonly projectRoot: string;
  readonly origin: DraftOrigin;
  readonly draftRevision: number;
  readonly head: SavedRevision;
  readonly revisions: readonly SavedRevision[];
  readonly state: "open" | "discarded" | "applied" | "published";
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SaveDraftInput {
  readonly projectRoot: string;
  readonly draftId: string;
  readonly expectedDraftRevision: number | null;
  readonly origin: DraftOrigin;
  readonly source: Uint8Array;
  readonly valid: boolean;
  readonly intent?: string;
}
export type AuthoringOperation =
  | "draft.save"
  | "draft.send"
  | "draft.discard"
  | "document.apply"
  | "document.publish"
  | "operation.send"
  | "change.withdraw"
  | "operation.resolve_uncertain";
export type JournalTarget =
  | {
      readonly kind: "draft";
      readonly draftId: string;
    }
  | {
      readonly kind: "document";
      readonly path: string;
      readonly blockId?: string;
    }
  | {
      readonly kind: "change";
      readonly changeId: string;
    }
  | {
      readonly kind: "operation";
      readonly operationId: string;
    };
export interface JournalExpected {
  readonly sourceRevision?: string | null;
  readonly draftRevision?: number;
  readonly reviewRevision?: number;
}
export interface JournalFeedback {
  readonly changes: "on_save" | "manual";
  readonly delivery: "next_call" | "next_call_and_notify";
  readonly effectiveRevision: string;
}
export interface JournalIntent {
  readonly operationId: string;
  readonly payloadDigest: string;
  readonly op: AuthoringOperation;
  readonly projectRoot: string;
  readonly authority: {
    readonly grantId: string;
    readonly entitlementId: string;
  };
  readonly feedback: JournalFeedback;
  readonly target: JournalTarget;
  readonly expected: JournalExpected;
  readonly base: SnapshotRef | null;
  readonly candidate: SnapshotRef | null;
  readonly intent?: string;
}
export type OperationOutcome =
  | "saved"
  | "unchanged"
  | "no_effect"
  | "applied"
  | "created"
  | "sent"
  | "discarded"
  | "withdrawn"
  | "resolved"
  | "conflict";
export interface JournalReview {
  readonly mode: "on_save" | "manual";
  readonly configRevision: string;
  readonly state:
    | "queued"
    | "not_queued_manual"
    | "not_queued_no_effect"
    | "not_queued_invalid"
    | "admission_pending"
    | "withdrawn"
    | "tracked"
    | "tracked_held";
  readonly changeId?: string;
  readonly reviewId?: string;
  readonly reviewRevision?: number;
}
export interface JournalCompletion {
  readonly outcome: OperationOutcome;
  readonly draft?: {
    readonly draftId: string;
    readonly draftRevision: number;
  };
  readonly document?: {
    readonly path: string;
    readonly blockId?: string;
    readonly sourceRevision: string;
    readonly modelRevision: string | null;
    readonly target?:
      | { readonly kind: "view"; readonly viewId: string }
      | { readonly kind: "embedded"; readonly address: string };
    readonly targetRevision?: string;
    readonly normalized?: {
      readonly pinnedName: boolean;
      readonly lineEndings: boolean;
    };
  };
  readonly review: JournalReview;
  readonly conflict?: {
    readonly kind: "source" | "draft" | "review" | "exists";
    readonly currentSourceRevision?: string | null;
    readonly currentDraftRevision?: number;
    readonly currentMatchesCandidate?: boolean;
  };
  readonly current?: {
    readonly observed: "matches_base" | "matches_candidate" | "diverged" | "missing";
    /** Compare-and-swap source token; embedded bodies may use salted identity. */
    readonly sourceRevision: string | null;
    /** SHA-256 of observed exact content bytes, independent from the CAS token. */
    readonly contentRevision: string | null;
    readonly inferred: true;
  };
  readonly evidence?: "observed" | "inferred_confirmed" | "abandoned";
}
export type JournalRecord = JournalIntent & {
  readonly epoch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} & (
    | {
        readonly state: "intent" | "uncertain";
      }
    | {
        readonly state: "terminal";
        readonly completion: JournalCompletion;
      }
  );
export interface AuthoringIndex {
  readonly version: 1 | 2;
  readonly serviceName: string;
  readonly storeId: string;
  readonly generation: string;
  readonly drafts: readonly SavedDraft[];
  readonly operations: readonly JournalRecord[];
  readonly reviews?: readonly CumulativeReview[];
}

/** Service-owned cumulative source review. Content hashes and source CAS tokens are distinct. */
export interface CumulativeReview {
  readonly reviewId: string;
  readonly projectRoot: string;
  readonly sequence: number;
  readonly subject: { readonly kind: "document"; readonly path: string; readonly blockId?: string };
  readonly state: "pending" | "cleared";
  readonly reviewRevision: number;
  readonly baseline: SnapshotRef | null;
  readonly latest: SnapshotRef;
  readonly latestSourceRevision: string;
  readonly firstOperationId: string;
  readonly lastOperationId: string;
  readonly saveCount: number;
  readonly externalGaps: number;
  readonly delivery: "offered" | "held";
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly clearedAt?: string;
  readonly clearedBy?: "agent";
  readonly summary?: string;
}
