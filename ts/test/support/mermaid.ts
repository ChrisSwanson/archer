// Loads the pinned `mermaid` under Node with no DOM shim. Mermaid needs the
// DOM only so DOMPurify can sanitize labels; research/12 recommends replacing
// DOMPurify with an identity stub, which returns every label as written. The
// stub is installed by patching the one DOMPurify instance Node resolves for
// both this module and Mermaid, before Mermaid first uses it.
import DOMPurify from "dompurify";

type Purify = { sanitize: (s: unknown) => string; addHook: () => void };
const purify = DOMPurify as unknown as Purify;
purify.sanitize = (s: unknown) => String(s);
purify.addHook = () => {};

type MermaidApi = {
  initialize: (config: { startOnLoad: boolean }) => void;
  mermaidAPI: { getDiagramFromText: (src: string) => Promise<{ db: unknown }> };
};

let loaded: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
  loaded ??= import("mermaid").then((m) => {
    const mermaid = m.default as unknown as MermaidApi;
    mermaid.initialize({ startOnLoad: false });
    return mermaid;
  });
  return loaded;
}

// Parses `source` with real Mermaid and returns the diagram's internal db.
export async function parseDb(source: string): Promise<unknown> {
  const mermaid = await loadMermaid();
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  return diagram.db;
}
