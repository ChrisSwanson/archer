// Source provenance travels beside parsed configuration without becoming a
// manifest field or changing serialized Project/GlobalConfig shapes.
import { createHash } from "node:crypto";

const revisions = new WeakMap<object, string>();

export function withConfigurationSource<T extends object>(value: T, source: string | Uint8Array): T {
  return withConfigurationRevision(value, `sha256:${createHash("sha256").update(source).digest("hex")}`);
}

export function withConfigurationRevision<T extends object>(value: T, revision: string): T {
  revisions.set(value, revision);
  return value;
}

export function configurationSourceRevision(value: object): string | undefined {
  return revisions.get(value);
}
