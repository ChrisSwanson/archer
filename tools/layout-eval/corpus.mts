/** The fixed corpus of the layout eval: diagrams with frames first, where the engine is weakest. */
const HERE = new URL(".", import.meta.url).pathname;
const ROOT = `${HERE}../../`;
const PAGETURNER = `${ROOT}tools/devkit/corpus/pageturner/.archer/diagrams`;
const AWKWARD = `${ROOT}tools/devkit/corpus/awkward/.archer/diagrams`;

/** Diagrams with frames first: they are where the engine is weakest. */
export const CORPUS: Record<string, string> = {
  "library-pricing": `${HERE}corpus/library-pricing.mmd`,
  // The owner's deployed library-pricing (2026-11-15), the source of the Data Sources screenshot.
  "library-pricing-deployed": `${HERE}corpus/library-pricing-deployed.mmd`,
  // The owner's Data Sources screenshot (2026-11-15): three one-to-one lines between two frames in opposite orders.
  "frames-order": `${HERE}corpus/frames-order.mmd`,
  // library-pricing with its Data Sources frame, as deployed (reconstructed: the deployed file is not on disk).
  "library-pricing-framed": `${HERE}corpus/library-pricing-framed.mmd`,
  "home-rig": `${ROOT}ui/tests/fixtures/palette/home-rig.mmd`,
  "flow-styled": `${AWKWARD}/flow-styled.mmd`,
  "c4-boundaries": `${AWKWARD}/c4-boundaries.mmd`,
  containers: `${PAGETURNER}/containers.mmd`,
  deployment: `${PAGETURNER}/deployment.mmd`,
  "system-context": `${PAGETURNER}/system-context.mmd`,
  fulfilment: `${PAGETURNER}/fulfilment.mmd`,
  "ship-loop": `${ROOT}ui/tests/fixtures/palette/ship-loop.mmd`,
};
