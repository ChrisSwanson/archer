// The one Mermaid instance: loaded on first use, reused by every parse, and
// used by one parse at a time.
//
// Mermaid keeps a module-level database per diagram type and clears it at the
// start of each parse, and some types hand every parse the same object
// (research 01). So parses are serialized, and the caller's `read` copies what
// it needs out of the database before the next parse may begin.

import { installPurifyStub } from "./purify-stub.ts";

/** What a parse hands `read`: Mermaid's diagram type and its database. */
export interface ParsedDiagram {
  type: string;
  /** Mermaid's internal database for the type; its shape is checked by the reader. */
  db: unknown;
}

/** Jison's error hash: where the parser stopped and what it wanted there. */
export interface ParserErrorHash {
  text?: unknown;
  token?: unknown;
  loc?: { first_line: number; last_line: number; first_column: number; last_column: number };
  expected?: unknown;
}

export interface MermaidFailure {
  message: string;
  hash?: ParserErrorHash;
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; failure: MermaidFailure };

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  mermaidAPI: { getDiagramFromText(text: string): Promise<{ type: string; db: unknown }> };
}

let loading: Promise<MermaidApi> | undefined;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<MermaidApi> {
  installPurifyStub();
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // Archer bounds the source itself (MAX_SOURCE_BYTES) and refuses before
    // Mermaid sees it; Mermaid's own, smaller bounds would refuse less clearly.
    maxTextSize: Number.MAX_SAFE_INTEGER,
    maxEdges: Number.MAX_SAFE_INTEGER,
    logLevel: "fatal",
  });
  return mermaid;
}

/** The loaded Mermaid, the same instance on every call. */
export function mermaidInstance(): Promise<MermaidApi> {
  loading ??= load();
  return loading;
}

function failureOf(thrown: unknown): MermaidFailure {
  if (thrown instanceof Error) {
    const hash = (thrown as Error & { hash?: unknown }).hash;
    return typeof hash === "object" && hash !== null
      ? { message: thrown.message, hash: hash as ParserErrorHash }
      : { message: thrown.message };
  }
  return { message: String(thrown) };
}

/**
 * Parse `text` with Mermaid and pass the result to `read`, which runs before
 * any other parse starts. A parse Mermaid refuses comes back as a failure,
 * never as a throw; an error thrown by `read` itself propagates.
 */
export function parseWithMermaid<T>(text: string, read: (diagram: ParsedDiagram) => T): Promise<ParseOutcome<T>> {
  const run = async (): Promise<ParseOutcome<T>> => {
    const api = await mermaidInstance();
    let diagram: { type: string; db: unknown };
    try {
      diagram = await api.mermaidAPI.getDiagramFromText(text);
    } catch (thrown) {
      return { ok: false, failure: failureOf(thrown) };
    }
    return { ok: true, value: read({ type: diagram.type, db: diagram.db }) };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
