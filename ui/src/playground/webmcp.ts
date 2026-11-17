import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";
import type { StaticControls } from "./webmcp-controls";
import type { createStaticRuntime } from "./runtime";
import { PLAYGROUND_TOOLS, PLAY_WALKTHROUGH } from "./tool-metadata";
import type { OperationDefinition } from "../../../shared/tool-definitions.mts";
import { validate } from "../../../shared/operation-arguments.mts";
import { parse, parseFor, resolve } from "../../../shared/emphasis-arguments.mts";
import { addressable, type Emphasis } from "../../../shared/emphasis.mts";
import type { DiagramEnvelope } from "../../../ts/src/model/envelope.ts";
import { validateEnvelope } from "../protocol/validate";
import { parseInventory } from "../app/inventory";
import { parseAllNotes } from "../app/contents-notes";
import { parseNoteContent, isTargetRef, parseAnchor } from "../comments/parse";
import { parseWalkthroughs } from "../walkthroughs/parse";
import { httpCommentsTransport } from "../comments/transport";
import { newOperation } from "../comments/operations";
import type { Anchor, CommentOperation, TargetRef } from "../comments/contract";
import { encodeAddress } from "./address";
import { elementsOf, ground, sequenceScopeLabels, type Subject } from "../../../shared/comment-grounding.mts";
import { locatePassage } from "../comments/state";
import { canonicalJson } from "../../../shared/comment-receipts.mts";
import {
  anchor as parseCommentAnchor,
  body as parseCommentBody,
  isObject as object,
} from "../../../shared/comment-shapes.mts";

export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(input: object, options: { signal: AbortSignal }): Promise<unknown>;
}
export interface ModelContext {
  registerTool(tool: BrowserTool, options: { signal: AbortSignal }): Promise<undefined>;
}
export interface ToolOptions {
  snapshot: PlaygroundSnapshot;
  /** Every example the document offers; defaults to the loaded ones. */
  catalog?: readonly { readonly slug: string; readonly name: string }[];
  runtime: ReturnType<typeof createStaticRuntime>;
  controls: () => StaticControls | undefined;
  document?: { modelContext?: unknown };
  navigator?: { modelContext?: unknown };
  onAvailability?: (available: boolean) => void;
}

/** The page's rendered-note passage match, as the overlay checks it. */
const found = (passage: Extract<Anchor, { kind: "passage" }>, markdown: string): boolean =>
  locatePassage(markdown, passage) !== null;

/** Bound the new input boundary before the shared schema validator ever echoes an unknown value. */
function argumentsOf(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new TypeError("Tool arguments must be an object.");
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0,
    characters = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.depth > 12 || ++count > 2000) throw new TypeError("Tool arguments exceed the nesting or item limit.");
    if (typeof next.value === "string") characters += next.value.length;
    else if (next.value !== null && typeof next.value === "object") {
      if (seen.has(next.value)) throw new TypeError("Tool arguments must not contain cycles or repeated containers.");
      seen.add(next.value);
      for (const [key, item] of Object.entries(next.value)) {
        characters += key.length;
        pending.push({ value: item, depth: next.depth + 1 });
      }
    } else if (!["number", "boolean", "undefined"].includes(typeof next.value) && next.value !== null)
      throw new TypeError("Tool arguments must be JSON values.");
    if (characters > 128 * 1024) throw new TypeError("Tool arguments exceed the text limit.");
  }
  return value;
}

function contextOf(value: unknown): ModelContext | undefined {
  return object(value) && typeof value.registerTool === "function" ? (value as unknown as ModelContext) : undefined;
}

/** W3C draft 2026-11-13: document-first, async registration, signal-owned lifetime; no network fallback. */
export function registerPlaygroundTools(options: ToolOptions) {
  const registration = new AbortController();
  const executions = new AbortController();
  const doc = options.document ?? (typeof document === "undefined" ? {} : (document as { modelContext?: unknown }));
  const nav = options.navigator ?? (typeof navigator === "undefined" ? {} : (navigator as { modelContext?: unknown }));
  const modelContext = contextOf(doc.modelContext) ?? contextOf(nav.modelContext);
  const binding = options.controls();
  const slug = binding?.context().projectSlug;
  const project = options.runtime.project(slug);
  const operationIds = new Map<string, CommentOperation>();
  let available = false;
  const dispose = () => {
    registration.abort();
    executions.abort();
    operationIds.clear();
    if (available) options.onAvailability?.(false);
    available = false;
  };
  const fresh = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!binding || !project || options.controls() !== binding || binding.context().projectSlug !== project.slug)
      throw new Error("The example project is no longer ready. Try again on the current page.");
    return binding;
  };
  const execute = async (
    definition: OperationDefinition,
    input: unknown,
    callerSignal: AbortSignal,
  ): Promise<unknown> => {
    const signal = AbortSignal.any([callerSignal, executions.signal]);
    const controls = fresh(signal);
    const args = argumentsOf(input);
    const violations = validate(definition.inputSchema, args);
    if (!violations.empty) throw new TypeError(violations.describe(definition.name));
    const read = async (path: string) => {
      fresh(signal);
      const response = await options.runtime.request(`/p/${project!.slug}/${path}`, { signal });
      if (!response.ok) throw new Error(`This example resource is unavailable (${response.status}).`);
      const result: unknown = await response.json();
      fresh(signal);
      return result;
    };
    const diagram = async (viewId: unknown) => {
      if (typeof viewId !== "string" || !project!.toolSources[`view:${viewId}`])
        throw new Error("Unknown example diagram.");
      const raw = await read(`api/diagrams/${encodeURIComponent(viewId)}`);
      const checked = validateEnvelope(raw);
      if (!checked.ok) throw new Error("Invalid example diagram.");
      return raw as DiagramEnvelope;
    };
    const emphasis = (raw: unknown, envelope: DiagramEnvelope, forView = false): Emphasis => {
      const draft = forView ? parseFor(raw, envelope.view.id) : parse(args);
      const resolved = resolve(draft, addressable(envelope.model));
      if ("issues" in resolved)
        throw new TypeError(resolved.issues.map((issue) => `${issue.where}: ${issue.problem}`).join("; "));
      return resolved.emphasis;
    };
    const subjectOf = async (target: TargetRef): Promise<Subject> => {
      if (target === "project:") return { kind: "project" };
      if (target.startsWith("note:")) {
        const note = parseNoteContent(
          await read(`api/notes/content?${new URLSearchParams({ path: target.slice(5) })}`),
        );
        return { kind: "note", text: note?.markdown ?? null };
      }
      const viewId = target.slice(5);
      const envelope = await diagram(viewId);
      const walks = parseWalkthroughs(await read(`api/walkthroughs?${new URLSearchParams({ viewId })}`));
      return {
        kind: "view",
        elements: elementsOf(envelope.model),
        ...(envelope.model.type === "sequence-trace" ? { scopedIdentities: sequenceScopeLabels(envelope.model) } : {}),
        walkthroughs: walks
          ? new Map(
              walks.walks.map((walk) => [
                walk.id,
                { title: walk.title, steps: walk.steps.map((step) => ({ id: step.id, title: step.title })) },
              ]),
            )
          : null,
        modelRevision: envelope.revision,
      };
    };
    let result: Record<string, unknown>;
    switch (definition.name) {
      case "list_projects":
        result = {
          projects: (options.catalog ?? options.snapshot.projects).map((project) => ({
            slug: project.slug,
            name: project.name,
            url: encodeAddress(`/projects/${project.slug}/`),
          })),
        };
        break;
      case "list_diagrams": {
        const views = parseInventory(await read("api/diagrams"));
        const notes = parseAllNotes(await read("api/notes/all"));
        if (!views || !notes) throw new Error("Invalid example inventory.");
        result = { views, notes };
        break;
      }
      case "read_diagram": {
        const envelope = await diagram(args.viewId);
        const source = project!.toolSources[`view:${args.viewId}`]!;
        result = {
          ...source,
          envelope,
          view: envelope.view,
          compile: { status: "compiled", sourceRevision: source.sourceRevision, diagnostics: [] },
        };
        break;
      }
      case "read_note": {
        const source = project!.toolSources[`note:${args.notePath}`];
        if (
          !source ||
          !parseNoteContent(await read(`api/notes/content?${new URLSearchParams({ path: String(args.notePath) })}`))
        )
          throw new Error("Unknown example note.");
        result = { ...source };
        break;
      }
      case "list_walkthroughs": {
        await diagram(args.viewId);
        const raw = await read(`api/walkthroughs?${new URLSearchParams({ viewId: String(args.viewId) })}`);
        const walks = parseWalkthroughs(raw);
        if (!walks || (args.id !== undefined && !walks.walks.some((walk) => walk.id === args.id)))
          throw new Error("Unknown saved walkthrough.");
        result = {
          viewId: args.viewId,
          walks: args.id === undefined ? walks.walks : walks.walks.filter((walk) => walk.id === args.id),
        };
        break;
      }
      case "set_emphasis": {
        const envelope = await diagram(args.viewId);
        const resolved = emphasis(args, envelope);
        fresh(signal);
        result = { emphasis: options.runtime.applyEmphasis(project!.slug, String(args.viewId), resolved), local: true };
        break;
      }
      case "present_diagram": {
        if (args.expand !== undefined || args.annotation !== undefined)
          throw new TypeError("Expansion and presentation captions are unavailable in this demo.");
        if (args.emphasis !== undefined && args.walkthrough !== undefined)
          throw new TypeError("Choose emphasis or a walkthrough.");
        const envelope = await diagram(args.viewId);
        if (args.expectedRevision !== undefined && args.expectedRevision !== envelope.revision)
          throw new Error("The model revision does not match this example.");
        const resolved = args.emphasis === undefined ? undefined : emphasis(args.emphasis, envelope, true);
        const walk = args.walkthrough as { id: string; step?: number } | undefined;
        if (walk) {
          const parsed = parseWalkthroughs(
            await read(`api/walkthroughs?${new URLSearchParams({ viewId: String(args.viewId) })}`),
          );
          const saved = parsed?.walks.find((item) => item.id === walk.id);
          if (saved?.status !== "current" || (walk.step ?? 1) > saved.steps.length)
            throw new Error("Unknown, outdated or out-of-range saved walkthrough.");
        }
        fresh(signal);
        await controls.present(
          { viewId: String(args.viewId), ...(walk === undefined ? {} : { walkthrough: walk }) },
          signal,
        );
        fresh(signal);
        if (resolved) options.runtime.applyEmphasis(project!.slug, String(args.viewId), resolved);
        result = {
          context: controls.context(),
          ui: {
            url: encodeAddress(`/projects/${project!.slug}/?${new URLSearchParams({ view: String(args.viewId) })}`),
          },
          local: true,
        };
        break;
      }
      case "play_walkthrough":
        await controls.controlWalk({ action: args.action as "play" | "pause" }, signal);
        fresh(signal);
        result = { context: controls.context(), local: true };
        break;
      case "create_comment": {
        if (!isTargetRef(args.target) || !object(args.anchor)) throw new TypeError("Invalid comment target or anchor.");
        const commentBody = parseCommentBody(args.body);
        // The live store's grounding: labels written from the example, anything absent refused.
        const grounded = ground(
          args.target,
          parseCommentAnchor(args.anchor, true),
          await subjectOf(args.target),
          found,
        );
        const anchor = parseAnchor(grounded);
        if (!anchor) throw new TypeError("Invalid comment anchor.");
        const identity = canonicalJson({
          target: args.target,
          anchor,
          body: commentBody,
          ...(args.expectedModelRevision === undefined ? {} : { expectedModelRevision: args.expectedModelRevision }),
        });
        let operation = operationIds.get(identity);
        if (!operation) {
          if (operationIds.size >= 100)
            throw new Error("This tool batch has reached its comment limit. Reset the demo to continue.");
          operation = newOperation("comment.create", args.target);
          operationIds.set(identity, operation);
        }
        const transport = httpCommentsTransport((url, init) => {
          fresh(signal);
          return options.runtime.request(`/p/${project!.slug}/${url}`, { ...init, signal });
        });
        const ack = await transport.createThreadOnce(operation, {
          target: args.target,
          anchor,
          body: commentBody,
          ...(typeof args.expectedModelRevision === "string"
            ? { expectedModelRevision: args.expectedModelRevision }
            : {}),
        });
        fresh(signal);
        result = { thread: ack.thread, operation, local: true };
        break;
      }
      default:
        throw new Error("Unavailable example tool.");
    }
    fresh(signal);
    return {
      ...(args.outputFormat === "text" ? { text: JSON.stringify(result) } : result),
      provenance: "static-playground",
    };
  };
  const ready = (async () => {
    if (!modelContext || !binding || !project || options.runtime.kind !== "static") return false;
    try {
      for (const definition of [...PLAYGROUND_TOOLS, PLAY_WALKTHROUGH]) {
        registration.signal.throwIfAborted();
        await modelContext.registerTool(
          {
            name: definition.name,
            description: definition.description,
            inputSchema: definition.inputSchema,
            execute: (input, { signal }) => execute(definition, input, signal),
          },
          { signal: registration.signal },
        );
      }
      fresh(executions.signal);
      available = true;
      options.onAvailability?.(true);
      return true;
    } catch {
      dispose();
      return false;
    }
  })();
  return { ready, dispose };
}
