import { classifyStaticRequest, validateStaticSelection, validateStaticPosition } from "./route-policy";
import type { PlaygroundSnapshot, PlaygroundProject } from "../../../shared/playground-snapshot.mts";
import { readBrowserRoute } from "../../../shared/browser-routes.mts";
import { parseInventory } from "../app/inventory";
import { parseCompileStatus } from "../app/compile-status";
import { parseCapabilities, parseNoteContent } from "../comments/parse";
import { parseEmphasisSnapshot } from "../emphasis/contract";
import { projectEnvelope } from "../diagrams/projection";
import { anchorMissing, type DrawnModel } from "../comments/canvas-anchors";
import { locatePassage } from "../comments/state";
import { parseWalkthroughs } from "../walkthroughs/parse";
import type { Anchor, TargetRef } from "../comments/contract";
import type { BridgeCallbacks } from "../app/host-bridge";
import type { PageRuntime, RuntimeFeatures, RuntimeVocabulary } from "../app/runtime.ts";
import type { HttpConnection } from "../app/http-connection";
import { createLocalComments } from "./comments";
import { addressable, EmphasisStore, type Emphasis, type EmphasisPayload } from "../../../shared/emphasis.mts";
import type { DiagramEnvelope } from "../../../ts/src/model/envelope.ts";
import type { StaticControls } from "./webmcp-controls";
import type { ProjectLoader } from "./load";
import { EXAMPLE_SETTINGS, playgroundExamples } from "./examples";

/**
 * A static example has no service: nothing to author, chat with, compare, send, search or watch on disk. Settings and
 * the chat show example data instead (`examples`).
 */
const STATIC_FEATURES: RuntimeFeatures = {
  authoring: false,
  chat: false,
  revisions: false,
  publishing: false,
  serverSearch: false,
  projectSettings: false,
  diskChanges: false,
};
const STATIC_VOCABULARY: RuntimeVocabulary = {
  commitComment: "Save comment",
  threadStatus: { label: "Saved locally", detail: "Changes stay in this browser." },
};

export interface StaticRuntime extends PageRuntime {
  readonly kind: "static";
  reset(): void;
  readonly memoryOnly: boolean;
  subscribe(listener: () => void): () => void;
  readonly controls: StaticControls | undefined;
  subscribeControls(listener: () => void): () => void;
  applyEmphasis(projectSlug: string, viewId: string, emphasis: Emphasis): EmphasisPayload;
  /** A project this page has downloaded (at boot or on demand); `subscribe` hears each arrival. */
  project(slug: string | undefined): PlaygroundProject | undefined;
  /** Whether this project's download failed; it is not tried again until `retry`. */
  loadFailed(slug: string | undefined): boolean;
  /** Forgets failed downloads, so the next request for a project downloads it again. */
  retry(): void;
}

export interface StaticRuntimeOptions {
  readonly snapshot: PlaygroundSnapshot;
  /** Always the logical address; the document codec owns physical addresses. */
  readonly href: () => string;
  readonly storage?: Storage | null;
  /**
   * Downloads a project the snapshot does not hold yet. In-app navigation, Back/Forward and project-addressed
   * requests may name any example; its data loads before the runtime answers for it.
   */
  readonly load?: ProjectLoader;
}
const refusal = (status: number, message: string): Response =>
  Response.json({ error: { code: "playground_unavailable", message } }, { status });
const query = (path: string, key: string, value: string): string => `${path}?${new URLSearchParams({ [key]: value })}`;

/** Immutable production responses plus local review. Unknown requests never delegate to fetch. */
export function createStaticRuntime(options?: StaticRuntimeOptions): StaticRuntime {
  const subscribers = new Set<BridgeCallbacks>();
  const stateListeners = new Set<() => void>();
  const reports = new Map<string, unknown>();
  const overlays = new Map<string, ReturnType<typeof createLocalComments>>();
  const emphasisStores = new Map<string, EmphasisStore>();
  const controlListeners = new Set<() => void>();
  let controls: StaticControls | undefined;
  const loaded = new Map((options?.snapshot.projects ?? []).map((project) => [project.slug, project]));
  const loading = new Map<string, Promise<PlaygroundProject | undefined>>();
  // A failed download stays failed until the person retries: the page's many reads never each download it again.
  const failed = new Map<string, unknown>();
  const changed = () => {
    for (const listener of [...stateListeners]) listener();
  };
  /** The routed project's slug; the Projects overview reads the first project the page holds. */
  const routed = (): string | undefined => {
    if (!options) return undefined;
    const url = new URL(options.href());
    const route = readBrowserRoute(url.pathname, url.search, url.hash);
    return route?.kind === "projects" ? options.snapshot.projects[0]?.slug : route?.projectSlug;
  };
  const current = (): PlaygroundProject | undefined => {
    const slug = routed();
    return slug === undefined ? undefined : loaded.get(slug);
  };
  /** The project, downloading it first when the snapshot lacks it; rejects when its download fails. */
  const ensure = async (slug: string | undefined): Promise<PlaygroundProject | undefined> => {
    if (slug === undefined) return undefined;
    const held = loaded.get(slug);
    if (held || !options?.load) return held;
    if (failed.has(slug)) throw failed.get(slug);
    let pending = loading.get(slug);
    if (!pending) {
      pending = options.load(slug).then(
        (project) => {
          if (project?.slug === slug) loaded.set(slug, project);
          changed();
          return loaded.get(slug);
        },
        (error: unknown) => {
          failed.set(slug, error);
          changed();
          throw error;
        },
      );
      pending.finally(() => loading.delete(slug)).catch(() => undefined);
      loading.set(slug, pending);
    }
    return pending;
  };
  const validateAnchor = (project: PlaygroundProject, target: TargetRef, anchor: Anchor): Anchor | undefined => {
    if (target === "project:") return anchor.kind === "project" ? anchor : undefined;
    if (target.startsWith("note:")) {
      const note = parseNoteContent(project.responses[query("api/notes/content", "path", target.slice(5))]);
      return note &&
        (anchor.kind === "view" || (anchor.kind === "passage" && locatePassage(note.markdown, anchor) !== null))
        ? anchor
        : undefined;
    }
    const id = target.slice(5);
    const projected = projectEnvelope(project.responses[`api/diagrams/${encodeURIComponent(id)}`]);
    if (!projected.ok) return undefined;
    const model: DrawnModel = projected;
    if (anchor.kind === "walkthrough" || anchor.kind === "step") {
      const walks = parseWalkthroughs(project.responses[query("api/walkthroughs", "viewId", id)]);
      return walks?.walks.some(
        (w) => w.id === anchor.walkthrough && (anchor.kind !== "step" || w.steps.some((s) => s.id === anchor.step)),
      )
        ? anchor
        : undefined;
    }
    if (anchor.kind === "selection")
      return [
        ...anchor.nodes.map((n) => ({ kind: "node" as const, ...n })),
        ...anchor.edges.map((e) => ({ kind: "edge" as const, ...e })),
      ].every((a) => !anchorMissing(model, a))
        ? anchor
        : undefined;
    return anchor.kind !== "project" && anchor.kind !== "passage" && !anchorMissing(model, anchor) ? anchor : undefined;
  };
  const overlay = (project: PlaygroundProject) => {
    let local = overlays.get(project.slug);
    if (!local) {
      local = createLocalComments({
        digest: options!.snapshot.manifest.digest,
        projectSlug: project.slug,
        storage: options!.storage,
        modelRevision: (target) => {
          const raw = project.responses[`api/diagrams/${encodeURIComponent(target.slice(5))}`] as
            | { revision?: string }
            | undefined;
          return raw?.revision;
        },
        validTarget: (target) => Object.hasOwn(project.responses, query("api/comments", "target", target)),
        validateAnchor: (target, anchor) => validateAnchor(project, target, anchor),
        notify: (changed) => {
          for (const callback of [...subscribers]) callback.onComments?.(changed);
          for (const listener of [...stateListeners]) listener();
        },
      });
      overlays.set(project.slug, local);
      for (const listener of [...stateListeners]) listener();
    }
    return local;
  };
  const adapter: StaticRuntime = {
    get controls() {
      return controls;
    },
    subscribeControls(listener) {
      controlListeners.add(listener);
      return () => {
        controlListeners.delete(listener);
      };
    },
    bindControls(binding) {
      controls = binding;
      for (const listener of [...controlListeners]) listener();
      return () => {
        if (controls !== binding) return;
        controls = undefined;
        for (const listener of [...controlListeners]) listener();
      };
    },
    applyEmphasis(projectSlug, viewId, emphasis) {
      const project = loaded.get(projectSlug);
      const envelope = project?.responses[`api/diagrams/${encodeURIComponent(viewId)}`] as DiagramEnvelope | undefined;
      if (!envelope || !project || viewId !== emphasis.viewId) throw new Error("Example diagram unavailable.");
      const key = `${projectSlug}:${viewId}`;
      let store = emphasisStores.get(key);
      const known = addressable(envelope.model);
      if (!store) {
        store = new EmphasisStore();
        const seed = project.responses[`api/emphasis/${encodeURIComponent(viewId)}`] as EmphasisPayload | undefined;
        for (const item of seed?.emphases ?? []) store.apply(item, known);
        emphasisStores.set(key, store);
      }
      const payload = store.apply(emphasis, known);
      const parsed = parseEmphasisSnapshot(payload);
      if (!parsed) throw new Error("Invalid example highlights.");
      if (current()?.slug === projectSlug) for (const callback of [...subscribers]) callback.onEmphasis?.(parsed);
      return payload;
    },
    project(slug) {
      return slug === undefined ? undefined : loaded.get(slug);
    },
    loadFailed(slug) {
      return slug !== undefined && failed.has(slug);
    },
    retry() {
      if (failed.size === 0) return;
      failed.clear();
      changed();
    },
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    kind: "static",
    features: STATIC_FEATURES,
    examples: playgroundExamples((slug) => loaded.get(slug)),
    vocabulary: STATIC_VOCABULARY,
    writable: (status) => status === "static-ready",
    async request(input, init) {
      init?.signal?.throwIfAborted();
      if (!options) return refusal(404, "No example snapshot is loaded.");
      const here = new URL(options.href());
      let url: URL;
      try {
        url = new URL(input, here.origin + "/");
      } catch {
        return refusal(400, "Invalid example request.");
      }
      if (url.origin !== here.origin || url.username || url.password)
        return refusal(403, "Example requests stay in this document.");
      const matched = /^\/p\/([a-z0-9-]+)\/(api\/.*)$/u.exec(url.pathname);
      let project: PlaygroundProject | undefined;
      try {
        project = await ensure(matched ? matched[1] : routed());
      } catch {
        return refusal(503, "This example project could not load. Check the connection and try again.");
      }
      init?.signal?.throwIfAborted();
      if (!project) return refusal(404, "This example project is unavailable.");
      const path = matched?.[2] ?? url.pathname.slice(1);
      const method = (init?.method ?? "GET").toUpperCase();
      const classified = classifyStaticRequest(method === "HEAD" ? "GET" : method, path.split("/"));
      if (!classified)
        return refusal(method === "GET" || method === "HEAD" ? 404 : 405, "This example request is unavailable.");
      if (classified.policy === "unavailable")
        return refusal(404, "This action is unavailable in the example. See About this demo.");
      // Archer Settings, as an example: read-only, like the service's own (ADR 0028), and changing nothing.
      if (classified.policy === "example")
        return method === "GET" || method === "HEAD"
          ? Response.json(EXAMPLE_SETTINGS)
          : refusal(405, "These are example settings; nothing here changes them.");
      // Overlay commits before its notification; every consumer subsequently reads the new state.
      const local = await overlay(project).request(path + url.search, init);
      if (local) {
        init?.signal?.throwIfAborted();
        return local;
      }
      if (method === "POST" && ["api/selection", "api/walkthrough-position"].includes(path)) {
        if (
          typeof init?.body !== "string" ||
          new TextEncoder().encode(init.body).length > (path === "api/selection" ? 64 * 1024 : 1024)
        )
          return refusal(422, "Invalid local state report.");
        let body: unknown;
        try {
          body = JSON.parse(init.body);
        } catch {
          return refusal(422, "Invalid JSON state report.");
        }
        const result =
          path === "api/selection" ? validateStaticSelection(body, project) : validateStaticPosition(body, project);
        if (!result.ok)
          return Response.json({ error: { code: result.code, message: result.message } }, { status: result.status });
        reports.set(`${project.slug}:${path}`, "selection" in result ? result.selection : result.position);
        return Response.json({ accepted: true });
      }
      if (method !== "GET" && method !== "HEAD") return refusal(405, "This action is unavailable in the example.");
      if (path === "api/authoring") return Response.json({ authorized: false });
      if (path === "api/listeners") return Response.json({ schemaVersion: 1, listeners: [] });
      if (path === "api/events" || path === "api/connection")
        return refusal(404, "Examples have no service connection.");
      let key = path;
      if (path.startsWith("api/thumbnails/"))
        key = query(path, "theme", url.searchParams.get("theme") === "dark" ? "dark" : "light");
      for (const parameter of ["viewId", "path", "address"]) {
        const value = url.searchParams.get(parameter);
        if (value !== null) {
          key = query(path, parameter, value);
          break;
        }
      }
      let body = project.responses[key];
      if (path.startsWith("api/emphasis/")) {
        const viewId = decodeURIComponent(path.slice("api/emphasis/".length));
        const store = emphasisStores.get(`${project.slug}:${viewId}`);
        if (store) body = store.payload(viewId);
      }
      if (key === "api/bootstrap" && body && typeof body === "object")
        body = {
          ...body,
          capabilities: { comments: true, notes: true, noteEmphasis: false, listeners: false, instanceSettings: true },
        };
      init?.signal?.throwIfAborted();
      if (body === undefined)
        return refusal(
          404,
          "This resource is unavailable in the example. Search, history, editing and service tools are not included.",
        );
      if (path.startsWith("api/thumbnails/") && typeof body === "string")
        return new Response(body, { headers: { "content-type": "image/svg+xml;charset=utf-8" } });
      return method === "HEAD" ? new Response(null, { status: 200 }) : Response.json(body);
    },
    resourceUrl(input) {
      if (!options) return null;
      try {
        const here = new URL(options.href());
        const url = new URL(input, here);
        if (url.origin !== here.origin) return null;
        const match = /^\/p\/([a-z0-9-]+)\/(api\/thumbnails\/[^/]+)$/u.exec(url.pathname);
        const project = match ? loaded.get(match[1]!) : undefined;
        const key = match ? query(match[2]!, "theme", url.searchParams.get("theme") === "dark" ? "dark" : "light") : "";
        const svg = project?.responses[key];
        return typeof svg === "string" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
      } catch {
        return null;
      }
    },
    connect(callbacks) {
      let closed = false;
      subscribers.add(callbacks);
      const deliver = (project: PlaygroundProject | undefined) => {
        if (closed) return;
        if (!project) {
          callbacks.onBootstrapError?.();
          return;
        }
        const inventory = parseInventory(project.responses["api/diagrams"]);
        const compile = parseCompileStatus(project.responses["api/compile"]);
        if (!inventory || !compile) {
          callbacks.onBootstrapError?.();
          return;
        }
        callbacks.onCapabilities?.({
          ...parseCapabilities(project.responses["api/bootstrap"]),
          comments: true,
          notes: true,
          listeners: false,
          // Example settings (`examples.ts`): the real dialog, read-only, labelled as an example.
          instanceSettings: true,
          noteEmphasis: false,
          projectName: project.name,
        });
        callbacks.onInventory?.(inventory);
        callbacks.onCompileStatus?.(compile);
        callbacks.onClear();
        callbacks.onConnection?.("static-ready");
      };
      // A project not yet downloaded loads first; a failed download reports as a failed bootstrap.
      void ensure(routed()).then(deliver, () => deliver(undefined));
      return {
        mode: "web",
        disconnect() {
          closed = true;
          subscribers.delete(callbacks);
        },
        setSelection(context) {
          const project = current();
          if (project) {
            const result = validateStaticSelection(context, project);
            if (result.ok) reports.set(`${project.slug}:api/selection`, result.selection);
          }
        },
        async fetchView(id) {
          const r = await adapter.request(`api/diagrams/${encodeURIComponent(id)}`);
          if (!r.ok) throw new Error("Example diagram unavailable");
          const body = await r.json();
          if (closed) throw new DOMException("Closed", "AbortError");
          return body;
        },
        async fetchEmphasis(id) {
          const r = await adapter.request(`api/emphasis/${encodeURIComponent(id)}`);
          const body = await r.json();
          if (closed) throw new DOMException("Closed", "AbortError");
          const value = parseEmphasisSnapshot(body.emphasisSnapshot ?? body);
          if (!value) throw new Error("Invalid example highlights");
          return body.emphasisSnapshot ?? body;
        },
      };
    },
    connection() {
      let closed = false;
      const events: HttpConnection["events"] = { onopen: null, onerror: null, addEventListener() {} };
      queueMicrotask(() => {
        if (!closed) events.onopen?.(new Event("open"));
      });
      const read = async (path: string) => {
        if (closed) throw new DOMException("Closed", "AbortError");
        const r = await adapter.request(path);
        if (!r.ok) throw new Error("Example resource unavailable");
        const body = await r.json();
        if (closed) throw new DOMException("Closed", "AbortError");
        return body;
      };
      return {
        events,
        read,
        readNumbered: async (path) => ({ body: await read(path), seq: null }),
        readConditional: async (path) => ({ status: 200, body: await read(path), etag: null, seq: null }),
        canSend: () => !closed,
        leaving: () => false,
        disconnect() {
          closed = true;
          events.onopen = null;
          events.onerror = null;
        },
      };
    },
    reset() {
      reports.clear();
      emphasisStores.clear();
      controls = undefined;
      for (const listener of [...controlListeners]) listener();
      for (const local of overlays.values()) local.reset();
    },
    get memoryOnly() {
      return [...overlays.values()].some((local) => local.memoryOnly);
    },
  };
  const dispatch = adapter.request;
  adapter.request = async (input, init) => {
    const response = await dispatch(input, init);
    const signal = init?.signal;
    if (!signal || !response.body) return response;
    signal.throwIfAborted();
    const reader = response.body.getReader();
    let detach = () => {};
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const abort = () => {
            controller.error(signal.reason);
            void reader.cancel(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          detach = () => signal.removeEventListener("abort", abort);
        },
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
              detach();
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            detach();
            controller.error(error);
          }
        },
        cancel(reason) {
          detach();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return adapter;
}
