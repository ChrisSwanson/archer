// Views for the project-model tests, compiled by the production compiler from Mermaid source.
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramEnvelope } from "../../src/model/index.ts";
import { defaultKind } from "../../src/model/index.ts";
import type { ModelInputView } from "../../src/project-model/merge.ts";

export interface ViewOptions {
  readonly title?: string;
  readonly embedded?: boolean;
  readonly status?: string;
  readonly basedOn?: string;
}

/** A view of `source`, as the inventory would give it; refuses a source that does not compile. */
export async function view(id: string, source: string, options: ViewOptions = {}): Promise<ModelInputView> {
  const { model, diagnostics } = await compile(source);
  if (model === null) throw new Error(`${id} does not compile: ${diagnostics.map((d) => d.message).join("; ")}`);
  const title = options.title ?? id;
  const envelope: DiagramEnvelope = {
    schemaVersion: 2,
    view: { id, kind: defaultKind(model), title },
    revision: `sha256:${"0".repeat(64)}`,
    model,
  };
  return {
    id,
    title,
    path: options.embedded === true ? `notes/${id}.md` : `diagrams/${id}.mmd`,
    embedded: options.embedded === true,
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.basedOn === undefined ? {} : { basedOn: options.basedOn }),
    envelope,
  };
}
