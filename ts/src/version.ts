// This build's version: package.json's, replaced when bundling (scripts/bundle.ts).
declare const ARCHER_VERSION: string | undefined;
export const version = (): string => (typeof ARCHER_VERSION === "string" ? ARCHER_VERSION : "0.0.0-dev");
