export type Access = string;
export interface Row {
  id: string;
  method: string;
  path: string;
  access: Access;
  surface?: string;
  file?: string;
  handler?: string;
  state?: boolean;
  cap?: string | null;
  anchors?: string[];
  body?: string;
  columns?: string[];
  stream?: boolean;
  note?: string;
  [key: string]: any;
}
export interface Inventory {
  rows: any[];
  management: any[];
  unclassified: { surface: string; file: string; line?: number; literal: string; why: string }[];
  stale: { id: string; anchor: string; why: string }[];
}
export interface Metrics {
  inventoryRows: { http: number; management: number };
  unclassified: number;
  stale: number;
  rowsMissingAdmission: { count: number; of: number; ids: string[] };
  rowsMissingOriginCheck: { count: number; of: number; ids: string[] };
  rowsMissingBodyCap: { count: number; of: number; ids: string[] };
}
export const HTTP_ROUTES: Row[];
export const DEBUG_ROUTES: Row[];
export const SOCKET_METHODS: Record<string, { state: boolean; grants?: boolean; secretBearing?: boolean }>;
export const OPERATION_CLASSES: Record<string, { state: boolean; capability?: boolean; note?: string }>;
export const COLUMNS: string[];
export function functionText(source: string, name: string): string | null;
export function routeLiterals(source: string): { literal: string; line: number }[];
export function tableLiterals(source: string): { literal: string; line: number }[];
export function socketMethods(socketSource: string, agentMethods: readonly string[]): string[] | null;
export function handlerFacts(
  text: string | null,
  cap: string | null | undefined,
): { originCheck: string; capInCode: boolean };
export function staticInventory(
  repo: string,
  registries: Record<string, any>,
  sources?: Record<string, string>,
): Inventory;
export function expected(
  row: { access: Access },
  column: string,
  options?: { edit?: boolean; profiling?: boolean },
): "admit" | "refuse" | "n/a" | "?";
export function classify(response: {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  error?: string;
}): { class: "admitted" | "refused" | "error"; code?: string; detail?: string };
export function verdict(
  expectation: string,
  observed: string,
): "pass" | "over-admit" | "under-admit" | "observed" | "error";
export function crossSiteVariants(origin: string): { name: string; headers: Record<string, string> }[];
export function stateHash(dirs: string[], skip?: RegExp): string;
export function metrics(inventory: Inventory): Metrics;
