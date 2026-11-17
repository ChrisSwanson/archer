// The project model outside the service (ADR 0036 §7, A2). With no service running for the
// project, each operation compiles the inventory once; a long-lived session (MCP) keeps what it
// compiled and recompiles only views whose source revision moved. A view whose source does not
// compile keeps the last model this session saw for it; one never seen compiling is named, since
// there is no last-good copy of it here.
import { compileDiagramBytes, type Project } from "../project/index.ts";
import { compileEmbedded } from "../notes/embedded.ts";
import type { DiagramEnvelope, Revision } from "../model/index.ts";
import { mergeProjectModel, modelSignature, type ModelInputView, type ProjectModel } from "../project-model/merge.ts";
import { entryOf, inventoryWithReads, readSource, type ViewEntry } from "./diagrams.ts";

export interface BuiltModel {
  readonly model: ProjectModel;
  /** Views with no model at all: their source does not compile and this session never saw it compile. */
  readonly notCompiled: readonly string[];
  /** Views whose source does not compile now (a last-good model may stand in for some). */
  readonly failing: readonly string[];
  /** How many views this build compiled; the rest were reused. */
  readonly compiled: number;
  /** What the merge read, in inventory order. */
  readonly inputs: readonly ModelInputView[];
  /** Each view's current sourceRevision (read_diagram's, a write's expectedRevision); null when it cannot be read. */
  readonly revisions: ReadonlyMap<string, Revision | null>;
}

export type Listing = Pick<ReturnType<typeof inventoryWithReads>, "views" | "embedded">;

interface Compiled {
  readonly revision: Revision | null;
  readonly envelope: DiagramEnvelope | null;
  readonly lastGood: DiagramEnvelope | null;
}

export class ProjectModelCache {
  readonly #views = new Map<string, Compiled>();
  #last: { readonly signature: string; readonly model: ProjectModel } | null = null;

  /** `listing`: the caller's own inventory of this project, so the folder is not walked again. */
  async build(project: Project, listing: Listing = inventoryWithReads(project)): Promise<BuiltModel> {
    const { views, embedded } = listing;
    let compiled = 0;
    const inputs: ModelInputView[] = [];
    const notCompiled: string[] = [];
    const failing: string[] = [];
    const seen = new Set<string>();
    const revisions = new Map<string, Revision | null>();
    for (const view of views) {
      const key = keyOf(view);
      seen.add(key);
      const before = this.#views.get(key);
      const read = view.registration === "embedded" ? embedded.get(view.id) : undefined;
      const source = read === undefined ? readSource(project, view) : undefined;
      const revision =
        read !== undefined
          ? read.sourceRevision
          : source !== undefined && "revision" in source
            ? source.revision
            : null;
      revisions.set(view.id, revision);
      let now: Compiled;
      if (before !== undefined && revision !== null && before.revision === revision) now = before;
      else {
        compiled++;
        const result =
          read !== undefined
            ? await compileEmbedded(read)
            : source?.status === "text"
              ? await compileDiagramBytes(entryOf(view), Buffer.from(source.text, "utf8"))
              : null;
        const envelope = result?.envelope ?? null;
        now = { revision, envelope, lastGood: envelope ?? before?.lastGood ?? null };
        this.#views.set(key, now);
      }
      if (now.envelope === null) failing.push(view.id);
      if (now.lastGood === null) notCompiled.push(view.id);
      inputs.push({
        id: view.id,
        title: view.title,
        path: view.source,
        embedded: view.registration === "embedded",
        ...(view.status === undefined ? {} : { status: view.status }),
        ...(view.basedOn === undefined ? {} : { basedOn: view.basedOn }),
        envelope: now.lastGood,
      });
    }
    for (const key of [...this.#views.keys()]) if (!seen.has(key)) this.#views.delete(key);
    const signature = modelSignature(inputs);
    const model = this.#last?.signature === signature ? this.#last.model : mergeProjectModel(inputs);
    this.#last = { signature, model };
    return { model, notCompiled: notCompiled.sort(), failing: failing.sort(), compiled, inputs, revisions };
  }
}

const keyOf = (view: ViewEntry): string => `${view.id}\0${view.source}\0${view.view?.kind ?? ""}`;
