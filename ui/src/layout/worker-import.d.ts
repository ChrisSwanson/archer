declare module "*?worker&inline" {
  const Constructor: { new (): Worker };
  export default Constructor;
}

declare module "*?worker&url" {
  const address: string;
  export default address;
}

/**
 * Vite's build-time values. DEV: true on the dev server (and in tests), false in a page build. ARCHER_TARGET: the
 * page target, defined by `vite build` only (`vite.config.ts`; `BUILT_FOR` in app/host-bridge.ts).
 */
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly ARCHER_TARGET?: "web" | "mcp" };
}
