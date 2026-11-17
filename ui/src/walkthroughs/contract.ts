/**
 * What the page holds of a walkthrough (ADR 0034). The wire is `GET api/walkthroughs?viewId=`
 * (`ts/src/walkthroughs/contract.ts`, `WalkthroughsForView`); `parse.ts` reads it into these,
 * with each step's resolution folded in, so nothing downstream joins two arrays by position.
 */
export const WALKTHROUGHS_SCHEMA_VERSION = 1;

/** A reference's, and so a step's, standing against the diagram now. */
export type RefStatus = "current" | "changed" | "out-of-date";
export type WalkStatus = "current" | "partly-out-of-date" | "archived";

export type WalkStep = {
  /** Stable across rewrites; a comment on the step anchors to it (ADR 0034 §9). */
  readonly id: string;
  readonly title: string;
  readonly kind: "sends" | "does";
  readonly what: string;
  readonly why?: string;
  readonly code: readonly string[];
  readonly nodes: readonly { readonly kind: "node" | "group"; readonly id: string; readonly label: string }[];
  readonly edges: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly label?: string;
  }[];
  readonly messages: readonly { readonly from: string; readonly to: string; readonly label: string }[];
  /** Its worst reference; `out-of-date` steps are listed, greyed, and draw nothing. */
  readonly status: RefStatus;
  /** What its out-of-date references used to point at, by their stored labels; empty when none is. */
  readonly missing?: readonly string[];
};

export type Walk = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** A related note, folder-relative (`notes/0001-….md`): linked from the panel. */
  readonly note?: string;
  /** When it was written, ISO 8601: the date an archived walkthrough is "written for". */
  readonly writtenAt?: string;
  /** The model revision it was written against. */
  readonly modelRevision: string;
  /** A starting open set (ADR 0029), container ids. */
  readonly open: readonly string[];
  readonly steps: readonly WalkStep[];
  readonly status: WalkStatus;
  /** 1-based step numbers. */
  readonly outOfDate: readonly number[];
  /** Set on the copy the page plays on the old version (`walk-stale.ts`): its steps all match that version. */
  readonly old?: true;
};

export type WalkthroughsRead = {
  readonly viewId: string;
  readonly walks: readonly Walk[];
  /** Why this view's family cannot host walkthroughs, when it cannot. */
  readonly unsupported?: string;
};
