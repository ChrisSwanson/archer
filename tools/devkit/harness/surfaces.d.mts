// Types for surfaces.mjs, for the page's TypeScript tests (ui/tests/browser-ts/a11y-sweep.e2e.ts).
import type { Browser, BrowserContext, Page } from "@playwright/test";

export type Target = {
  origin: string;
  login: string;
  slug: string;
  projects: string[];
  source: string;
  serviceOrigin?: string;
  emphasisDiagram?: string;
  embeddedPage?: boolean;
  zero?: Target;
  embedded?: Target;
};
export type State = {
  id: string;
  surface: string;
  label: string;
  family?: string;
  fresh?: boolean;
  open(page: Page, target: Target): Promise<unknown>;
  leave?(page: Page): Promise<void>;
};
export type Opened = {
  ok: boolean;
  url: string;
  notAvailable?: string;
  error?: string;
  evidence?: Record<string, unknown>;
};
export const VIEWPORTS: Record<string, { width: number; height: number; coarse: boolean }>;
export const THEMES: string[];
export const FIXTURES: { family: string; file: string }[];
export const STATES: State[];
export function isMain(metaUrl: string): boolean;
export function settle(page: Page, dwellMs?: number): Promise<void>;
export function selectList<T>(all: T[], wanted: string | undefined, key?: (x: T) => string): T[];
export function selectCells(o?: { surfaces?: string; viewports?: string; themes?: string }): {
  states: State[];
  viewports: string[];
  themes: string[];
};
export function resolveTarget(values?: Record<string, string | undefined>, env?: NodeJS.ProcessEnv): Target;
export function loginState(browser: Browser, target: Target): Promise<{ cookies: unknown[]; origins: unknown[] }>;
export function blockDevHelpers(context: BrowserContext): Promise<void>;
export function cellContext(
  browser: Browser,
  o?: {
    viewport?: string;
    theme?: string;
    reducedMotion?: "reduce" | "no-preference";
    flowAnimation?: string;
    storageState?: unknown;
    extra?: Record<string, unknown>;
  },
): Promise<BrowserContext>;
export function openState(page: Page, state: State, target: Target): Promise<Opened>;
export function leaveState(page: Page, state: State): Promise<void>;
export function redact(text: string): string;
export function writeReport(dir: string, name: string, json: unknown, markdown: string): { json: string; md: string };
export function defaultOut(tool: string): string;
export function mdTable(header: string[], rows: unknown[][]): string;
export function sandboxTarget(
  sandbox: {
    origin?: string;
    link: string;
    name: string;
    projects?: (string | { slug: string })[];
    embedded?: boolean;
  },
  slug?: string,
): Target;
