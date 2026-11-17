/**
 * A controllable `prefers-color-scheme`, because jsdom implements no
 * `matchMedia` at all.
 *
 * Returns a setter that flips the OS preference AND notifies listeners, so a
 * test can move the OS underneath the page the way a real theme change at
 * sunset does -- which is the case that distinguishes "currently dark" from
 * "chose dark".
 */
export function installMatchMedia(prefersDark: boolean): (next: boolean) => void {
  let matches = prefersDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      // A width or pointer query is answered as a desktop window would answer
      // it: the colour scheme is the only thing this helper moves.
      const desktop = viewportAnswer(query, DESKTOP);
      if (desktop !== undefined) return desktop;
      return query.includes("dark") ? matches : !matches;
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;

  return (next: boolean) => {
    matches = next;
    for (const listener of [...listeners]) {
      listener({ matches: next } as MediaQueryListEvent);
    }
  };
}

/**
 * A controllable `prefers-reduced-motion`.
 *
 * Kept separate from `installMatchMedia` because that helper answers every
 * non-dark query with the INVERSE of the dark preference, which would make
 * "reduce motion" mean "prefers light". Every other query answers `false`
 * here, which is the browser default for a preference nobody has expressed.
 */
export function installReducedMotion(reduce: boolean): (next: boolean) => void {
  let matches = reduce;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query.includes("prefers-reduced-motion") ? matches : false;
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;

  return (next: boolean) => {
    matches = next;
    for (const listener of [...listeners]) {
      listener({ matches: next } as MediaQueryListEvent);
    }
  };
}

/**
 * Make every `localStorage` call throw, as a browser in private mode or with
 * storage disabled does. Returns a restore function.
 */
export function breakLocalStorage(): () => void {
  const real = window.localStorage;
  const thrower = {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
    removeItem: () => {
      throw new Error("storage disabled");
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: thrower });
  return () => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: real });
  };
}

/** A window, as far as the page's media queries can see one. */
export type Viewport = { readonly width: number; readonly coarse: boolean };

const DESKTOP: Viewport = { width: 1440, coarse: false };

/**
 * How a window of `viewport` answers a width or pointer query, or `undefined`
 * for any other query. Only the forms the page writes are read:
 * `(min-width: Npx)`, `(max-width: Npx)`, `(pointer: coarse|fine)` and
 * `(hover: none|hover)`.
 */
export function viewportAnswer(query: string, viewport: Viewport): boolean | undefined {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query);
  if (min !== null) return viewport.width >= Number(min[1]);
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  if (max !== null) return viewport.width <= Number(max[1]);
  if (/\(pointer:\s*coarse\)/.test(query) || /\(hover:\s*none\)/.test(query)) return viewport.coarse;
  if (/\(pointer:\s*fine\)/.test(query) || /\(hover:\s*hover\)/.test(query)) return !viewport.coarse;
  return undefined;
}

/**
 * A window of a given width and pointer, for the page's layout queries. Every
 * other query answers `false`. Returns a setter that moves the window and
 * notifies every listener, as rotating a phone or resizing a window does.
 */
export function installViewport(initial: Viewport): (next: Viewport) => void {
  let viewport = initial;
  const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();

  window.matchMedia = ((query: string) => {
    const own = listeners.get(query) ?? new Set();
    listeners.set(query, own);
    return {
      media: query,
      get matches() {
        return viewportAnswer(query, viewport) ?? false;
      },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => own.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => own.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    };
  }) as unknown as typeof window.matchMedia;

  return (next: Viewport) => {
    viewport = next;
    for (const [query, own] of listeners) {
      const matches = viewportAnswer(query, viewport) ?? false;
      for (const listener of [...own]) listener({ matches, media: query } as MediaQueryListEvent);
    }
  };
}
