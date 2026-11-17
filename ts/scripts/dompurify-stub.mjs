// Stands in for DOMPurify in the bundle (research/12-dom-shim-and-label-safety.md).
// Mermaid calls only `sanitize` and `addHook`; with no DOM, the real library has
// neither, and Archer does not rely on Mermaid's sanitizing anyway: its validator
// refuses HTML and control characters in labels, and each painter escapes its own
// output. So labels pass through exactly as written.
const DOMPurify = {
  sanitize: (text) => String(text),
  addHook: () => {},
  removeHook: () => {},
  removeHooks: () => {},
  removeAllHooks: () => {},
  setConfig: () => {},
  clearConfig: () => {},
  isSupported: false,
};

export default DOMPurify;
export const sanitize = DOMPurify.sanitize;
export const addHook = DOMPurify.addHook;
