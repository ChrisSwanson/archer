import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads a read-only protocol fixture from `fixtures/protocol/valid`.
 *
 * Tests must not invent envelope shapes: the fixtures are the contract the
 * server actually emits, so render tests exercise the same data the real host
 * delivers.
 *
 * Resolution goes through `process.cwd()` (the `ui/` project root under
 * Vitest) rather than `import.meta.url`, because in the jsdom environment
 * `import.meta.url` is a served `http://…/@fs/…` URL, not a `file:` one.
 */
export function loadValidFixture(name: string): unknown {
  const path = resolve(process.cwd(), "../fixtures/protocol/valid", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The view kind each of the newer model types is shown as. */
const KIND_OF_MODEL: Readonly<Record<string, string>> = {
  "state-machine": "state",
  "entity-relationship": "entity-relationship",
  "c4-model": "c4",
  "service-architecture": "architecture",
  "user-journey": "journey",
};

/**
 * A model the TypeScript compiler produced from a golden Mermaid source
 * (`ts/test/fixtures/<type>/<name>.json`, checked against the `.mmd` beside it
 * by that workspace's suite), in an envelope as the service sends it.
 */
export function loadModelEnvelope(
  type: string,
  name: string,
  viewId = `${type}-${name}`,
): {
  schemaVersion: 2;
  view: { id: string; kind: string; title: string };
  revision: string;
  model: { type: string } & Record<string, unknown>;
} {
  const path = resolve(process.cwd(), "../ts/test/fixtures", type, `${name}.json`);
  const model = JSON.parse(readFileSync(path, "utf8")) as { type: string } & Record<string, unknown>;
  return envelopeFor(model, viewId, `${type} ${name}`);
}

/** A compiled model in an envelope as the service sends it. */
export function envelopeFor(
  model: { type: string } & Record<string, unknown>,
  viewId: string,
  title = viewId,
): {
  schemaVersion: 2;
  view: { id: string; kind: string; title: string };
  revision: string;
  model: { type: string } & Record<string, unknown>;
} {
  return {
    schemaVersion: 2,
    view: { id: viewId, kind: KIND_OF_MODEL[model.type] ?? "freeform", title },
    revision: `sha256:${"a".repeat(64)}`,
    model,
  };
}
