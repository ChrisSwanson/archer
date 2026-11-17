import type { PlaygroundProject, PlaygroundSnapshot } from "./playground-snapshot.mts";

/** The project the landing's compact scene shows; it loads no other project's data. */
export const HERO_PROJECT = "archer-tour";

/**
 * The public playground's delivery format (ADR 0037, amended): a small index inline in the document and
 * one cacheable JSON file per project plus one for the responses every project shares, fetched on route.
 * `packSnapshot` and `unpackProject` are inverse: the build proves the round trip before it publishes.
 */
export interface PlaygroundIndex {
  readonly formatVersion: 1;
  readonly manifest: PlaygroundSnapshot["manifest"];
  readonly fontLicense: string;
  /** Document-relative URL of the shared responses. */
  readonly shared: string;
  readonly projects: readonly PlaygroundIndexEntry[];
}

export interface PlaygroundIndexEntry {
  readonly slug: string;
  readonly name: string;
  readonly notice?: string;
  /** Document-relative URL of the project's packed responses. */
  readonly data: string;
}

/** Light thumbnail text plus the dark theme's colour tokens that differ from it (index, value). */
export interface PackedThumbnail {
  readonly svg: string;
  readonly dark: readonly (readonly [number, string])[] | { readonly svg: string };
}

export interface PackedProject {
  readonly responses: Readonly<Record<string, unknown>>;
  readonly thumbnails: Readonly<Record<string, PackedThumbnail>>;
  /** Long strings repeated within the project (a note's Markdown in its note and document reads). */
  readonly strings: readonly string[];
  readonly toolSources: PlaygroundProject["toolSources"];
}

export interface PackedShared {
  readonly responses: Readonly<Record<string, unknown>>;
}

const REF = "\u0000archer-string";
const MIN_INTERNED = 256;
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const LIGHT = "?theme=light";
const DARK = "?theme=dark";

function walk(value: unknown, visit: (text: string) => unknown): unknown {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, visit));
  if (value !== null && typeof value === "object") {
    if (Object.hasOwn(value, REF)) throw new Error("A snapshot response uses the reserved string-reference key.");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, visit)]));
  }
  return value;
}

function restore(value: unknown, strings: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => restore(item, strings));
  if (value !== null && typeof value === "object") {
    const ref = (value as Record<string, unknown>)[REF];
    if (typeof ref === "number") {
      const text = strings[ref];
      if (text === undefined) throw new Error("The example data names a missing string.");
      return text;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, strings)]));
  }
  return value;
}

function packThumbnail(light: string, dark: string): PackedThumbnail {
  const lightText = light.split(COLOUR);
  const darkText = dark.split(COLOUR);
  if (lightText.length !== darkText.length || lightText.some((part, index) => part !== darkText[index]))
    return { svg: light, dark: { svg: dark } };
  const lightColours = light.match(COLOUR) ?? [];
  const patch: [number, string][] = [];
  (dark.match(COLOUR) ?? []).forEach((colour, index) => {
    if (colour !== lightColours[index]) patch.push([index, colour]);
  });
  return { svg: light, dark: patch };
}

/** The dark thumbnail is the light one with its differing colour tokens replaced. */
export function darkThumbnail(packed: PackedThumbnail): string {
  if (!Array.isArray(packed.dark)) return (packed.dark as { readonly svg: string }).svg;
  const replacements = new Map(packed.dark as readonly (readonly [number, string])[]);
  let index = 0;
  return packed.svg.replace(COLOUR, (colour) => replacements.get(index++) ?? colour);
}

export function packSnapshot(snapshot: PlaygroundSnapshot): { shared: PackedShared; projects: PackedProject[] } {
  const [first, ...rest] = snapshot.projects;
  const shared: Record<string, unknown> = {};
  if (first && rest.length > 0)
    for (const [key, value] of Object.entries(first.responses)) {
      const text = JSON.stringify(value);
      if (rest.every((project) => JSON.stringify(project.responses[key]) === text)) shared[key] = value;
    }
  const projects = snapshot.projects.map((project): PackedProject => {
    const own: Record<string, unknown> = {};
    const thumbnails: Record<string, PackedThumbnail> = {};
    for (const [key, value] of Object.entries(project.responses)) {
      if (Object.hasOwn(shared, key)) continue;
      if (key.startsWith("api/thumbnails/") && typeof value === "string") {
        const path = key.endsWith(LIGHT)
          ? key.slice(0, -LIGHT.length)
          : key.endsWith(DARK)
            ? key.slice(0, -DARK.length)
            : "";
        const light = project.responses[path + LIGHT];
        const dark = project.responses[path + DARK];
        if (path !== "" && typeof light === "string" && typeof dark === "string") {
          thumbnails[path] ??= packThumbnail(light, dark);
          continue;
        }
      }
      own[key] = value;
    }
    const counts = new Map<string, number>();
    const count = (text: string) => {
      if (text.length >= MIN_INTERNED) counts.set(text, (counts.get(text) ?? 0) + 1);
      return text;
    };
    walk(own, count);
    walk(project.toolSources, count);
    const strings = [...counts].filter(([, uses]) => uses > 1).map(([text]) => text);
    const position = new Map(strings.map((text, index) => [text, index]));
    const intern = (text: string) => (position.has(text) ? { [REF]: position.get(text) } : text);
    return {
      responses: walk(own, intern) as Record<string, unknown>,
      thumbnails,
      strings,
      toolSources: walk(project.toolSources, intern) as PlaygroundProject["toolSources"],
    };
  });
  return { shared: { responses: shared }, projects };
}

/** Reassemble the exact production responses of one project. */
export function unpackProject(
  entry: Pick<PlaygroundIndexEntry, "slug" | "name" | "notice">,
  packed: PackedProject,
  shared: PackedShared,
): PlaygroundProject {
  const responses: Record<string, unknown> = {
    ...shared.responses,
    ...(restore(packed.responses, packed.strings) as Record<string, unknown>),
  };
  for (const [path, thumbnail] of Object.entries(packed.thumbnails)) {
    responses[path + LIGHT] = thumbnail.svg;
    responses[path + DARK] = darkThumbnail(thumbnail);
  }
  return {
    slug: entry.slug,
    name: entry.name,
    ...(entry.notice === undefined ? {} : { notice: entry.notice }),
    responses,
    toolSources: restore(packed.toolSources, packed.strings) as PlaygroundProject["toolSources"],
  };
}
