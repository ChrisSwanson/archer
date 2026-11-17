import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { withChangeStoreIo, type ChangeStoreIo, type ChangeStoreIoHook } from "../changes/io.ts";
import {
  parsePresentationPositions,
  parsePresentationRevision,
  presentationObject,
  type AuthoringPresentation,
  type PresentationPositions,
} from "../../../shared/authoring-presentation.mts";
export interface PresentationStoreOptions {
  stateDir: string;
  serviceName: string;
  assertOwner: () => void;
  onCommitStep?: ChangeStoreIoHook;
}
export interface PresentationPut {
  projectRoot: string;
  targetRevision: string;
  sourceRevision: string;
  expectedRevision: string | null;
  positions: PresentationPositions;
}
interface Entry {
  projectRoot: string;
  targetRevision: string;
  presentation: AuthoringPresentation;
}
interface Index {
  version: 1;
  serviceName: string;
  entries: Entry[];
}
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const limits = { entries: 1024, physicalBytes: 12 * 1024 * 1024, snapshotBytes: 0 },
  indexBytes = 8 * 1024 * 1024;
export class PresentationStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string): never => {
  throw new PresentationStoreError("authoring_presentation_invalid", message);
};
const project = (v: unknown): string => {
  if (typeof v !== "string" || Buffer.byteLength(v) > 4096 || !isAbsolute(v) || resolve(v) !== v || /[\0-\x1f]/.test(v))
    return bad("invalid project identity");
  return v;
};
function canonical(sourceRevision: string, positions: PresentationPositions) {
  return JSON.stringify({
    sourceRevision,
    positions: Object.fromEntries(
      Object.keys(positions)
        .sort()
        .map((id) => [id, positions[id]]),
    ),
  });
}
const revision = (source: string, positions: PresentationPositions) => `sha256:${hash(canonical(source, positions))}`;
export function parsePresentationIndex(bytes: Uint8Array): Index {
  try {
    if (bytes.byteLength > indexBytes) return bad("indexBytes exceeded");
    const text = Buffer.from(bytes).toString("utf8");
    if (!Buffer.from(text).equals(Buffer.from(bytes))) return bad("invalid UTF-8");
    const v = presentationObject(JSON.parse(text), ["version", "serviceName", "entries"]);
    if (
      v.version !== 1 ||
      typeof v.serviceName !== "string" ||
      !v.serviceName ||
      v.serviceName.length > 128 ||
      /[\0-\x1f\x7f]/.test(v.serviceName) ||
      !Array.isArray(v.entries) ||
      v.entries.length > 1024
    )
      return bad("invalid presentation index");
    const keys = new Set<string>();
    const entries = v.entries.map((item) => {
      const e = presentationObject(item, ["projectRoot", "targetRevision", "presentation"]),
        p = presentationObject(e.presentation, ["revision", "sourceRevision", "positions"]),
        sourceRevision = parsePresentationRevision(p.sourceRevision),
        positions = parsePresentationPositions(p.positions),
        r = parsePresentationRevision(p.revision);
      if (r !== revision(sourceRevision, positions)) return bad("presentation digest differs");
      const entry = {
          projectRoot: project(e.projectRoot),
          targetRevision: parsePresentationRevision(e.targetRevision),
          presentation: { revision: r, sourceRevision, positions },
        },
        key = JSON.stringify([entry.projectRoot, entry.targetRevision]);
      if (keys.has(key)) return bad("duplicate presentation");
      keys.add(key);
      return entry;
    });
    return { version: 1, serviceName: v.serviceName, entries };
  } catch (error) {
    if (error instanceof PresentationStoreError) throw error;
    return bad("invalid presentation authority");
  }
}
/** Singleton service-owned private sidecar. Never writes canonical Mermaid. */
export class AuthoringPresentationStore {
  #index!: Index;
  #authority = "";
  #unavailable = false;
  #binding!: string;
  #markerBinding!: string;
  readonly #root: string;
  constructor(readonly options: PresentationStoreOptions) {
    options.assertOwner();
    this.#root = join(options.stateDir, "runtime/authoring-presentations");
    if (!options.serviceName || options.serviceName.length > 128 || /[\0-\x1f\x7f]/.test(options.serviceName))
      bad("invalid service name");
    this.#io((io) => {
      const inventory = io.inventory(limits);
      if (!io.existsIndex()) {
        if (inventory.entries !== 0) bad("presentation index missing from nonempty area");
        io.ensureSnapshots();
        io.replaceIndex(
          Buffer.from(JSON.stringify({ version: 1, serviceName: options.serviceName, entries: [] })),
          options.onCommitStep,
        );
      }
      const bytes = io.readIndex(indexBytes);
      this.#index = parsePresentationIndex(bytes);
      if (this.#index.serviceName !== options.serviceName) bad("service identity differs");
      io.existsSnapshot("0".repeat(64));
      if (io.inventory(limits).entries < 2) bad("initialization marker missing");
      io.syncOpenBindings();
      this.#authority = hash(bytes);
    });
    this.#binding = this.#rootBinding();
    this.#markerBinding = this.#rootBinding("snapshots");
  }
  #rootBinding(child = "") {
    const s = lstatSync(join(this.#root, child));
    if (!s.isDirectory()) bad("root binding differs");
    if (child) {
      const directory = opendirSync(join(this.#root, child));
      try {
        if (directory.readSync() !== null) bad("initialization marker is not empty");
      } finally {
        directory.closeSync();
      }
    }
    return `${s.dev}:${s.ino}`;
  }
  #io<T>(f: (io: ChangeStoreIo) => T): T {
    try {
      return withChangeStoreIo(this.options.stateDir, f, "authoring-presentations");
    } catch (error) {
      if (!(error instanceof PresentationStoreError && error.code === "authoring_presentation_limit"))
        this.#unavailable = true;
      throw error;
    }
  }
  #guard() {
    this.options.assertOwner();
    if (this.#unavailable)
      throw new PresentationStoreError("authoring_presentation_unavailable", "presentation store unavailable");
    try {
      if (this.#rootBinding() !== this.#binding || this.#rootBinding("snapshots") !== this.#markerBinding)
        bad("root binding differs");
      this.#io((io) => {
        if (hash(io.readIndex(indexBytes)) !== this.#authority) bad("presentation authority changed");
        io.inventory(limits);
      });
    } catch (error) {
      this.#unavailable = true;
      throw error;
    }
  }
  get(projectRoot: string, targetRevision: string): AuthoringPresentation | null {
    this.#guard();
    const root = project(projectRoot),
      target = parsePresentationRevision(targetRevision);
    return structuredClone(
      this.#index.entries.find((e) => e.projectRoot === root && e.targetRevision === target)?.presentation ?? null,
    );
  }
  put(input: PresentationPut): AuthoringPresentation {
    this.#guard();
    const v = presentationObject(input, [
        "projectRoot",
        "targetRevision",
        "sourceRevision",
        "expectedRevision",
        "positions",
      ]),
      root = project(v.projectRoot),
      target = parsePresentationRevision(v.targetRevision),
      source = parsePresentationRevision(v.sourceRevision),
      expected = v.expectedRevision === null ? null : parsePresentationRevision(v.expectedRevision),
      positions = parsePresentationPositions(v.positions),
      current = this.#index.entries.find((e) => e.projectRoot === root && e.targetRevision === target),
      next = { revision: revision(source, positions), sourceRevision: source, positions };
    if (current?.presentation.revision === next.revision) return structuredClone(current.presentation);
    if ((current?.presentation.revision ?? null) !== expected)
      throw new PresentationStoreError("authoring_presentation_conflict", "presentation revision conflict");
    const entries = this.#index.entries.filter((e) => e !== current);
    entries.push({ projectRoot: root, targetRevision: target, presentation: next });
    if (entries.length > 1024) throw new PresentationStoreError("authoring_presentation_limit", "entries exceeded");
    const index: Index = { ...this.#index, entries },
      bytes = Buffer.from(JSON.stringify(index));
    if (bytes.length > indexBytes)
      throw new PresentationStoreError("authoring_presentation_limit", "indexBytes exceeded");
    this.#io((io) => {
      const inventory = io.inventory(limits);
      if (inventory.physicalBytes + bytes.length > limits.physicalBytes)
        throw new PresentationStoreError("authoring_presentation_limit", "physicalBytes exceeded");
      io.replaceIndex(bytes, this.options.onCommitStep);
      io.syncOpenBindings();
    });
    this.#index = index;
    this.#authority = hash(bytes);
    return structuredClone(next);
  }
}
