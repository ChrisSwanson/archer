import type { Page } from "playwright";
export type TokenCount = { raw: number; tokens: number };
export type TokenDeclaration = {
  file: string;
  line: number;
  selector: string;
  property: string;
  value: string;
  category: "fontSize" | "iconSize" | "spacing";
  raw: boolean;
  tokens: boolean;
};
export type CssAudit = {
  ok: boolean;
  metricPolicy: "compared";
  counts: { fontSize: TokenCount; iconSize: TokenCount; spacing: TokenCount };
  declarations: TokenDeclaration[];
};
export function auditCss(css: string, options?: { file?: string }): CssAudit;
export function staticCensus(root?: string): CssAudit & { files: number; definitions: Record<string, string> };
export function measureTokens(
  page: Page,
  options?: { surface?: string },
): Promise<{ ok: boolean; sizes: number[]; offScale: Array<{ fontSizePx: number }> }>;
