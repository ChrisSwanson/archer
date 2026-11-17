import type {
  AuthoringAccessStatus,
  AuthoringOpen,
  AuthoringReceipt,
  AuthoringRequest,
  AuthoringSnapshot,
  AuthoringTarget,
} from "../../../shared/authoring-contract.mts";
import { parseAuthoringRequest } from "../../../shared/authoring-contract.mts";
import { STARTER_PREVIEW, STARTER_SOURCE } from "../../../shared/authoring-starter.mts";
import {
  parsePresentationRequest,
  parsePresentationPositions,
  parsePresentationRevision,
  presentationObject,
  type PresentationRequest,
  type PresentationResponse,
} from "../../../shared/authoring-presentation.mts";
import { browserFetch } from "../app/browser-resource";
/** The shared edit operations; each type reads its own parameters (flowchart shape/line, C4 element/relation). */
export type FlowchartEdit =
  | { kind: "relabel-node" | "relabel-edge"; id: string; label: string }
  | { kind: "change-shape"; id: string; shape: string }
  | {
      kind: "add-node";
      id: string;
      label: string;
      shape?: string;
      element?: string;
      external?: boolean;
      state?: string;
      participant?: "participant" | "actor";
    }
  | {
      kind: "connect";
      id?: string;
      source: string;
      target: string;
      label?: string;
      line?: "dotted" | "thick";
      relation?: "rel" | "birel";
      cardinality?: string;
      identifying?: boolean;
      message?: "sync" | "reply" | "async";
      after?: string | null;
    }
  | { kind: "delete-node" | "delete-edge"; id: string }
  | { kind: "direction"; direction: string }
  | { kind: "move-node"; id: string; before: string | null }
  | {
      kind: "retarget-edge";
      id: string;
      source?: string;
      target?: string;
      message?: "sync" | "reply" | "async";
      cardinality?: string;
      identifying?: boolean;
    }
  | { kind: "move-edge"; id: string; before: string | null }
  | {
      kind: "add-note";
      participants: string[];
      position: "over" | "left of" | "right of";
      text: string;
      after?: string | null;
    }
  | { kind: "wrap-edges"; ids: string[]; fragment: string; label: string }
  | { kind: "relabel-note"; id: string; text: string }
  | { kind: "delete-note"; id: string }
  | { kind: "unwrap-fragment"; id: string }
  /** Flowchart edge or sequence message: one head at the target, heads at both ends, or the ends swapped (heads kept). */
  | { kind: "change-arrow"; id: string; arrow: ArrowChange }
  /** Flowchart: a readable ID on every edge written without one; works on a source that doesn't compile yet. */
  | { kind: "add-edge-ids" };
export type ArrowChange = "one-way" | "two-way" | "reverse";
export interface Preview {
  envelope: unknown | null;
  diagnostics: readonly unknown[];
}
/** A refusal may carry the compiler's first diagnostic (`edit_requires_valid_*`) or the existing relationship's id. */
export type Edited =
  | ({ ok: true; source: string } & Preview)
  | {
      ok: false;
      source: string;
      code: string;
      diagnostic?: { message: string; line?: number; code?: string };
      existingId?: string;
    };
export interface AuthoringClient {
  presentation(request: PresentationRequest): Promise<PresentationResponse>;
  status(): Promise<AuthoringAccessStatus>;
  open(target: AuthoringTarget): Promise<AuthoringOpen>;
  preview(source: string): Promise<Preview>;
  edit(source: string, edit: FlowchartEdit): Promise<Edited>;
  snapshot(draftId: string, draftRevision: number): Promise<AuthoringSnapshot>;
  mutate(request: AuthoringRequest): Promise<AuthoringReceipt>;
  operation(id: string): Promise<AuthoringReceipt | null>;
}
/** A refusal the service answered with: its code and HTTP status. A 4xx means the request had no effect; 5xx may be uncertain. */
export class AuthoringRefusal extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthoringRefusal";
  }
}
/** A write the service definitively refused (4xx): nothing happened, so nothing is left to check. */
export const definitiveRefusal = (failure: unknown): failure is AuthoringRefusal =>
  failure instanceof AuthoringRefusal && failure.status >= 400 && failure.status < 500;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bad = (): never => {
  throw new Error("The server returned an unreadable authoring response.");
};
function receipt(value: unknown): AuthoringReceipt {
  if (
    !record(value) ||
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.operationId) ||
    !["intent", "uncertain", "terminal"].includes(String(value.state))
  )
    return bad();
  return value as unknown as AuthoringReceipt;
}
export function authoringClient(fetcher: typeof browserFetch = browserFetch): AuthoringClient {
  async function read(path: string, body?: unknown): Promise<unknown> {
    const response = await fetcher(
      `api/authoring${path}`,
      body === undefined
        ? { cache: "no-store", credentials: "same-origin" }
        : {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
      throw new Error("The authoring response exceeded its limit.");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        response.ok
          ? "The server returned an unreadable response."
          : "Authoring is unavailable. Refresh access and try again.",
      );
    }
    if (!response.ok)
      throw new AuthoringRefusal(
        record(value) && typeof value.message === "string"
          ? value.message
          : record(value) && record(value.error) && typeof value.error.message === "string"
            ? value.error.message
            : record(value) && typeof value.error === "string"
              ? value.error
              : "The authoring request was refused.",
        record(value) && record(value.error) && typeof value.error.code === "string" ? value.error.code : null,
        response.status,
      );
    return value;
  }
  function preview(value: unknown): Preview {
    if (!record(value) || !Array.isArray(value.diagnostics) || !("envelope" in value)) return bad();
    return { envelope: value.envelope, diagnostics: value.diagnostics };
  }
  return {
    async presentation(request) {
      const v = await read("/presentation", parsePresentationRequest(request));
      if (!record(v) || !("presentation" in v)) return bad();
      if (v.presentation === null) return { presentation: null };
      const p = presentationObject(v.presentation, ["revision", "sourceRevision", "positions"]);
      return {
        presentation: {
          revision: parsePresentationRevision(p.revision),
          sourceRevision: parsePresentationRevision(p.sourceRevision),
          positions: parsePresentationPositions(p.positions),
        },
      };
    },
    async status() {
      const v = await read("");
      if (!record(v) || typeof v.authorized !== "boolean") return bad();
      if (!v.authorized) return { authorized: false };
      if (
        typeof v.storeId !== "string" ||
        typeof v.generation !== "string" ||
        !Array.isArray(v.drafts) ||
        !Array.isArray(v.operations) ||
        v.drafts.length > 256 ||
        v.operations.length > 100 ||
        (v.unfinishedOperations !== undefined &&
          (!Array.isArray(v.unfinishedOperations) || v.unfinishedOperations.length > 4096)) ||
        (v.heldSourceOperations !== undefined &&
          (!Array.isArray(v.heldSourceOperations) || v.heldSourceOperations.length > 256)) ||
        !record(v.edit) ||
        typeof v.edit.enabled !== "boolean"
      )
        return bad();
      return v as unknown as AuthoringAccessStatus;
    },
    async open(target) {
      const v = await read("/open", { target });
      if (
        !record(v) ||
        typeof v.source !== "string" ||
        typeof v.sourceRevision !== "string" ||
        typeof v.targetRevision !== "string" ||
        typeof v.path !== "string" ||
        typeof v.authoringPath !== "string" ||
        typeof v.writable !== "boolean"
      )
        return bad();
      return v as unknown as AuthoringOpen;
    },
    // The new-diagram starter has nothing authored to compile: its preview is the service's own answer, kept in shared/.
    async preview(source) {
      if (source === STARTER_SOURCE) return STARTER_PREVIEW;
      return preview(await read("/preview", { source }));
    },
    async edit(source, edit) {
      const v = await read("/edit", { source, edit });
      if (!record(v) || typeof v.ok !== "boolean" || typeof v.source !== "string") return bad();
      if (!v.ok) {
        if (typeof v.code !== "string") return bad();
        const d =
          record(v.diagnostic) && typeof v.diagnostic.message === "string"
            ? {
                message: v.diagnostic.message,
                ...(typeof v.diagnostic.line === "number" ? { line: v.diagnostic.line } : {}),
                ...(typeof v.diagnostic.code === "string" ? { code: v.diagnostic.code } : {}),
              }
            : undefined;
        return {
          ok: false,
          source: v.source,
          code: v.code,
          ...(d ? { diagnostic: d } : {}),
          ...(typeof v.existingId === "string" ? { existingId: v.existingId } : {}),
        };
      }
      return { ok: true, source: v.source, ...preview(v) };
    },
    async snapshot(draftId, draftRevision) {
      const v = await read("/snapshot", { draftId, draftRevision });
      if (
        !record(v) ||
        v.draftId !== draftId ||
        v.draftRevision !== draftRevision ||
        typeof v.source !== "string" ||
        typeof v.valid !== "boolean"
      )
        return bad();
      return v as unknown as AuthoringSnapshot;
    },
    async mutate(request) {
      if (request.journalGeneration === undefined)
        throw new Error("The request lacks its original authoring generation. No write was sent.");
      const result = receipt(await read("", parseAuthoringRequest(request)));
      if (result.operationId !== request.operationId) return bad();
      return result;
    },
    async operation(id) {
      const v = await read(`/operations/${encodeURIComponent(id)}`);
      if (!record(v) || !("operation" in v)) return bad();
      if (v.operation === null) return null;
      const result = receipt(v.operation);
      if (result.operationId !== id) return bad();
      return result;
    },
  };
}
export function newOperationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
}
