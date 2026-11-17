export function parseCsp(text: unknown): Record<string, string[]>;
export function parseCookie(header: string): { name: string; attributes: Record<string, string | true> };
export const CLASSES: Record<string, { auth: boolean; html?: boolean; type: string | null }>;
export function collect(target: {
  origin: string;
  ca?: Buffer | string;
  grantToken: string;
  ownerToken: string;
  pairingCode?: string;
  slug: string;
  view?: string | undefined;
  revision?: string | undefined;
  asset?: string | undefined;
}): Promise<any>;
export function evaluate(
  snapshot: any,
): { row: string; predicate: string; class: string; pass: boolean; observed: unknown }[];
export function summarize(
  results: { row: string; predicate: string; class: string; pass: boolean; observed: unknown }[],
): { predicates: number; passing: number; failing: number; failingByRow: Record<string, string[]> };
