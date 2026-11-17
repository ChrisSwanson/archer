import { parseAuthoringTarget, type AuthoringTarget } from "./authoring-contract.mts";
export type PresentationPositions = Record<string, { x: number; y: number }>;
export interface AuthoringPresentation {
  revision: string;
  sourceRevision: string;
  positions: PresentationPositions;
}
export type PresentationRequest =
  | { op: "read"; target: AuthoringTarget; expectedTargetRevision: string; sourceRevision?: string }
  | {
      op: "save";
      target: AuthoringTarget;
      expectedTargetRevision: string;
      sourceRevision: string;
      expectedRevision: string | null;
      positions: PresentationPositions;
    };
export interface PresentationResponse {
  presentation: AuthoringPresentation | null;
}
export class PresentationInputError extends Error {
  readonly code = "authoring_presentation_invalid";
}
const bad = (): never => {
  throw new PresentationInputError("invalid presentation input");
};
export function presentationObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    return bad();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Object.keys(descriptors);
  if (
    keys.length > required.length + optional.length ||
    required.some((k) => !Object.hasOwn(descriptors, k)) ||
    keys.some((k) => !required.includes(k) && !optional.includes(k)) ||
    keys.some((k) => descriptors[k]?.get || descriptors[k]?.set)
  )
    return bad();
  return value as Record<string, unknown>;
}
export function parsePresentationRevision(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) return bad();
  return value;
}
export function parsePresentationPositions(value: unknown): PresentationPositions {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    return bad();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > 2048) return bad();
  const result: PresentationPositions = {};
  for (const id of keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return bad();
    const descriptor = Object.getOwnPropertyDescriptor(value, id);
    if (!descriptor || descriptor.get || descriptor.set) return bad();
    const p = presentationObject(descriptor.value, ["x", "y"]);
    if (
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.abs(p.x) > 1e7 ||
      Math.abs(p.y) > 1e7
    )
      return bad();
    result[id] = { x: p.x, y: p.y };
  }
  return result;
}
export function parsePresentationRequest(value: unknown): PresentationRequest {
  try {
    const v = presentationObject(
      value,
      ["op", "target", "expectedTargetRevision"],
      ["sourceRevision", "expectedRevision", "positions"],
    );
    const target = parseAuthoringTarget(v.target),
      expectedTargetRevision = parsePresentationRevision(v.expectedTargetRevision);
    if (v.op === "read") {
      presentationObject(v, ["op", "target", "expectedTargetRevision"], ["sourceRevision"]);
      return {
        op: "read",
        target,
        expectedTargetRevision,
        ...(v.sourceRevision !== undefined ? { sourceRevision: parsePresentationRevision(v.sourceRevision) } : {}),
      };
    }
    if (v.op !== "save") return bad();
    presentationObject(v, [
      "op",
      "target",
      "expectedTargetRevision",
      "sourceRevision",
      "expectedRevision",
      "positions",
    ]);
    return {
      op: "save",
      target,
      expectedTargetRevision,
      sourceRevision: parsePresentationRevision(v.sourceRevision),
      expectedRevision: v.expectedRevision === null ? null : parsePresentationRevision(v.expectedRevision),
      positions: parsePresentationPositions(v.positions),
    };
  } catch {
    return bad();
  }
}
