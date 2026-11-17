// One executable comment shape validator for the live store and browser-local tools.
import { isStableId } from "../ts/src/model/ids.ts";
import { WALKTHROUGH_ID } from "../ts/src/walkthroughs/contract.ts";
import {
  MAX_COMMENT_CHARS,
  MAX_CONTEXT_DOCUMENT_CHARS,
  MAX_CONTEXT_PAGE_CHARS,
  MAX_PASSAGE_CONTEXT_CHARS,
  MAX_PASSAGE_QUOTE_CHARS,
  MAX_SELECTION_ELEMENTS,
  type Anchor,
  type WalkthroughContext,
  type CommentContext,
} from "../ts/src/comments/contract.ts";
export class Bad extends Error {}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const chars = (s: string): number => [...s].length;

export function hasControl(text: string, allowLines: boolean): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (allowLines && (c === 9 || c === 10 || c === 13)) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

export function only(object: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) throw new Bad(`${where} has a field "${key.slice(0, 32)}" that comments do not have`);
}

export function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Bad(`${where} must be text`);
  return value;
}

/** A comment body: text, not blank, at most MAX_COMMENT_CHARS, no control characters but line breaks and tabs. */
export function body(value: unknown, where = "the comment"): string {
  if (typeof value !== "string") throw new Bad(`${where} must be text`);
  if (value.trim() === "") throw new Bad(`${where} is empty`);
  const length = chars(value);
  if (length > MAX_COMMENT_CHARS)
    throw new Bad(`${where} is ${length} characters, and a comment holds at most ${MAX_COMMENT_CHARS}`);
  if (hasControl(value, true)) throw new Bad(`${where} holds a control character`);
  return value;
}

/** `fresh`: a new thread's element, whose label Archer writes from the diagram (`ground`), so it may be left out. */
export function labelled(value: unknown, where: string, fresh = false): { id: string; label: string } {
  if (!isObject(value)) throw new Bad(`${where} must be an object with an id${fresh ? "" : " and a label"}`);
  only(value, ["id", "label"], where);
  const id = text(value["id"], `${where}.id`);
  if (!isStableId(id)) throw new Bad(`${where}.id is not an element id`);
  return { id, label: fresh && value["label"] === undefined ? "" : text(value["label"], `${where}.label`) };
}

export function context(value: unknown, where: string): WalkthroughContext {
  if (!isObject(value)) throw new Bad(`${where} must be an object with a walkthrough and a step`);
  only(value, ["walkthrough", "step"], where);
  const walkthrough = text(value["walkthrough"], `${where}.walkthrough`),
    step = text(value["step"], `${where}.step`);
  if (!WALKTHROUGH_ID.test(walkthrough)) throw new Bad(`${where}.walkthrough is not a walkthrough id`);
  if (!WALKTHROUGH_ID.test(step)) throw new Bad(`${where}.step is not a step id`);
  return { walkthrough, step };
}

/**
 * A comment's `context`: the page route it was sent from and, on a diagram or note page, the project-relative
 * file path. Text, bounded, no control characters.
 */
export function commentContext(value: unknown, where: string): CommentContext {
  if (!isObject(value)) throw new Bad(`${where} must be an object with a page`);
  only(value, ["page", "document"], where);
  const bounded = (field: "page" | "document", limit: number): string => {
    const t = text(value[field], `${where}.${field}`);
    if (t === "") throw new Bad(`${where}.${field} is empty`);
    if (chars(t) > limit) throw new Bad(`${where}.${field} is over ${limit} characters`);
    if (hasControl(t, false)) throw new Bad(`${where}.${field} holds a control character`);
    return t;
  };
  const page = bounded("page", MAX_CONTEXT_PAGE_CHARS);
  return value["document"] === undefined
    ? { page }
    : { page, document: bounded("document", MAX_CONTEXT_DOCUMENT_CHARS) };
}

/** The optional `context` of an element anchor, as a spread. */
export const withContext = (value: Record<string, unknown>, where: string): { context?: WalkthroughContext } =>
  value["context"] === undefined ? {} : { context: context(value["context"], `${where}'s context`) };

/**
 * An anchor's shape, as the contract types it. Whether it names anything real is `ground`'s question. `fresh`: the
 * anchor of a new thread, whose element labels may be left out (create_comment's schema: Archer writes them).
 */
export function anchor(value: unknown, fresh = false): Anchor {
  if (!isObject(value)) throw new Bad("the anchor must be an object with a kind");
  const kind = value["kind"];
  switch (kind) {
    case "view":
      only(value, ["kind"], "a view anchor");
      return { kind };
    case "project":
      only(value, ["kind"], "a project anchor");
      return { kind };
    case "node":
    case "edge":
    case "group": {
      only(value, ["kind", "id", "label", "context"], `a ${kind} anchor`);
      const { id, label } = labelled(
        { id: value["id"], ...(value["label"] === undefined ? {} : { label: value["label"] }) },
        `the ${kind} anchor`,
        fresh,
      );
      return { kind, id, label, ...withContext(value, `the ${kind} anchor`) };
    }
    case "selection": {
      only(value, ["kind", "nodes", "edges", "context"], "a selection anchor");
      const lists = (["nodes", "edges"] as const).map((field) => {
        const list = value[field];
        if (!Array.isArray(list)) throw new Bad(`the selection's ${field} must be a list`);
        return list;
      });
      const [nodes = [], edges = []] = lists;
      const count = nodes.length + edges.length;
      if (count === 0) throw new Bad("the selection names no element");
      if (count > MAX_SELECTION_ELEMENTS)
        throw new Bad(`the selection names ${count} elements, and a comment anchors at most ${MAX_SELECTION_ELEMENTS}`);
      return {
        kind,
        nodes: nodes.map((n, i) => labelled(n, `the selection's nodes[${i}]`, fresh)),
        edges: edges.map((e, i) => labelled(e, `the selection's edges[${i}]`, fresh)),
        ...withContext(value, "the selection anchor"),
      };
    }
    case "walkthrough": {
      only(value, ["kind", "walkthrough", "label"], "a walkthrough anchor");
      const walkthrough = text(value["walkthrough"], "the walkthrough anchor's walkthrough");
      if (!WALKTHROUGH_ID.test(walkthrough))
        throw new Bad("the walkthrough anchor's walkthrough is not a walkthrough id");
      return {
        kind,
        walkthrough,
        label: value["label"] === undefined ? "" : text(value["label"], "the walkthrough anchor's label"),
      };
    }
    case "step": {
      only(value, ["kind", "walkthrough", "step", "label"], "a step anchor");
      const { walkthrough, step } = context(
        { walkthrough: value["walkthrough"], step: value["step"] },
        "the step anchor",
      );
      return {
        kind,
        walkthrough,
        step,
        label: value["label"] === undefined ? "" : text(value["label"], "the step anchor's label"),
      };
    }
    case "passage": {
      only(value, ["kind", "quote", "prefix", "suffix"], "a passage anchor");
      const quote = text(value["quote"], "the passage's quote");
      if (quote.trim() === "") throw new Bad("the passage's quote is empty");
      if (chars(quote) > MAX_PASSAGE_QUOTE_CHARS)
        throw new Bad(`the passage's quote is over ${MAX_PASSAGE_QUOTE_CHARS} characters`);
      const [prefix, suffix] = (["prefix", "suffix"] as const).map((field) => {
        const context = text(value[field], `the passage's ${field}`);
        if (chars(context) > MAX_PASSAGE_CONTEXT_CHARS)
          throw new Bad(`the passage's ${field} is over ${MAX_PASSAGE_CONTEXT_CHARS} characters`);
        return context;
      });
      return { kind, quote, prefix: prefix ?? "", suffix: suffix ?? "" };
    }
    default:
      throw new Bad(
        `the anchor's kind must be one of view, node, edge, group, selection, walkthrough, step, passage, project`,
      );
  }
}
