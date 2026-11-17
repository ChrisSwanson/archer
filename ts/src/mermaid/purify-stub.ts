// Mermaid sanitizes every flowchart label through DOMPurify, which needs a
// DOM. Archer runs Mermaid with no DOM shim (research 12) and wants each label
// exactly as written: its own validator refuses HTML and control characters,
// and every painter escapes for its own medium.
//
// Mermaid imports the `dompurify` module's default export and calls only
// `sanitize` and `addHook` on it. Without a DOM that export carries neither,
// so they are filled in here, on the one shared module instance Mermaid sees,
// with an identity and a no-op. A bundle can alias `dompurify` to an identity
// module instead (research 12); this keeps the unbundled server and the tests
// on the same behaviour. It affects every user of `dompurify` in the process,
// and Archer's server has no other.

import DOMPurify from "dompurify";

interface PurifySurface {
  sanitize: (dirty: unknown) => string;
  addHook: (...args: unknown[]) => void;
  isSupported?: boolean;
}

let installed = false;

/** Make DOMPurify return its input unchanged. Idempotent. */
export function installPurifyStub(): void {
  if (installed) return;
  // The default export's declared type is the full DOMPurify interface with
  // overloads; only these two members are replaced, so it is viewed through
  // the narrow surface Mermaid uses.
  const purify = DOMPurify as unknown as PurifySurface;
  purify.sanitize = (dirty: unknown) => String(dirty);
  purify.addHook = () => {};
  installed = true;
}
