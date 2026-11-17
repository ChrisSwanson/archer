// createManagementHandler (service/management.ts): the management methods, with startService's state passed in.
// The integration tests (service, relay, handover, authoring-grants-management...) cover them over the socket;
// these pin what the handler itself owns: wire refusals, the stop and hand-over, and late reads of its inputs.
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthoringStoreError } from "../../src/authoring/store.ts";
import { WriteRuleDenied } from "../../src/config/write-policy.ts";
import { createManagementHandler, type ManagementDeps } from "../../src/service/management.ts";
import { StateRefusal } from "../../src/service/project-state.ts";
import { PROTOCOL_VERSION, type Request } from "../../src/service/protocol.ts";
import { MethodError } from "../../src/service/socket.ts";
import { PersistenceError } from "../../src/state/account.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);

function deps(overrides: Partial<ManagementDeps> = {}) {
  const lines: string[] = [];
  const closes: (boolean | undefined)[] = [];
  const base = {
    options: {},
    log: (line: string) => lines.push(line),
    serviceName: "default",
    stateDir: tempDir(),
    socketPath: "/tmp/archer-test.sock",
    host: "127.0.0.1",
    port: 4321,
    advertisedHost: "127.0.0.1",
    transport: { scheme: "http", automatic: true },
    transportOptions: {},
    configuredTransport: { pairingCodeMinutes: 5 },
    admission: "any",
    restoreState: true,
    openBrowser: false,
    maxProjects: 64,
    page: "/page/index.html",
    retainedPage: undefined,
    homeUrl: "http://127.0.0.1:4321/tok/",
    pageUrl: (slug: string) => `http://127.0.0.1:4321/projects/${slug}/`,
    projects: new Map(),
    restoring: new Map(),
    restoringStatus: new Map(),
    restoreCancelled: new Set(),
    restoreFailures: new Map(),
    store: {},
    projectKey: (root: string) => root,
    projectName: (root: string) => root,
    attached: (root: string) => {
      throw new MethodError("project_not_attached", `no project is attached at ${root}; attach it first`);
    },
    status: () => ({ root: "/", name: "", url: "" }),
    register: () => {},
    discoverySettings: () => ({}),
    observeLifecycle: () => ({}),
    watchProject: () => ({}),
    watchThumbnails: () => {},
    endStreams: () => {},
    telemetry: null,
    getChanges: () => ({}),
    savedAuthoring: { peek: () => undefined },
    getSavedAuthoring: () => ({}),
    reviewArtifact: () => ({ status: "unavailable", message: "" }),
    artifactJobs: { schedule: () => {} },
    grants: {},
    grantStreams: new Map(),
    pairing: {},
    getAuthoringGrants: () => ({}),
    unbracket: (h: string) => h.replace(/^\[|\]$/g, ""),
    delivery: {},
    close: async (handingOver?: boolean) => {
      closes.push(handingOver);
    },
  } as unknown as ManagementDeps;
  return { deps: { ...base, ...overrides } as ManagementDeps, lines, closes };
}

const call = (method: string, params: unknown = {}): Request => ({ id: 1, method, params }) as unknown as Request;

describe("createManagementHandler", () => {
  test("hello answers this service's identity, and refuses another protocol version", async () => {
    const { deps: d } = deps();
    const handle = createManagementHandler(d);
    await expect(handle(call("hello", { protocolVersion: PROTOCOL_VERSION }), true)).resolves.toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      homeUrl: "http://127.0.0.1:4321/tok/",
      serviceName: "default",
    });
    await expect(handle(call("hello", { protocolVersion: -1 }), true)).rejects.toMatchObject({
      code: "protocol_version_mismatch",
    });
  });

  test("stop answers first and stops on the next turn; handover says so and hands over", async () => {
    vi.useFakeTimers();
    try {
      const { deps: d, closes, lines } = deps();
      const handle = createManagementHandler(d);
      await expect(handle(call("stop"), true)).resolves.toEqual({ stopping: true });
      expect(closes).toEqual([]);
      await vi.runAllTimersAsync();
      expect(closes).toEqual([undefined]);
      await expect(handle(call("handover"), true)).resolves.toEqual({ stopping: true });
      expect(lines).toContain("[archer] service: handing over to the replacement");
      await vi.runAllTimersAsync();
      expect(closes).toEqual([undefined, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("mcpRelay is refused without an MCP host", async () => {
    const handle = createManagementHandler(deps().deps);
    await expect(handle(call("mcpRelay"), true)).rejects.toMatchObject({ code: "mcp_unavailable" });
    const hosted = createManagementHandler(deps({ options: { hostMcp: async () => {} } }).deps);
    await expect(hosted(call("mcpRelay"), true)).resolves.toEqual({ relaying: true });
  });

  test("store and policy refusals keep their wire codes and details", async () => {
    const throwing = (error: Error) =>
      createManagementHandler(
        deps({
          attached: () => {
            throw error;
          },
        }).deps,
      );
    const review = Object.assign(new AuthoringStoreError("authoring_review_conflict", "moved on"), {
      currentReviewRevision: 7,
    });
    const caught = await throwing(review)(call("getContext", { root: "/p" }), true).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(MethodError);
    expect((caught as MethodError).toWire()).toMatchObject({
      code: "authoring_review_conflict",
      message: "moved on",
      details: { currentReviewRevision: 7 },
    });
    const persistence = await throwing(new PersistenceError("invalid_saved_state", "bad"))(
      call("getContext", { root: "/p" }),
      true,
    ).catch((e: unknown) => e);
    expect(persistence).toBeInstanceOf(MethodError);
    expect((persistence as MethodError).toWire()).toMatchObject({ code: "invalid_saved_state", message: "bad" });
    const state = await throwing(new StateRefusal("view_not_found", "no view", { viewId: "v" }))(
      call("getContext", { root: "/p" }),
      true,
    ).catch((e: unknown) => e);
    expect((state as MethodError).toWire()).toMatchObject({ code: "view_not_found", details: { viewId: "v" } });
  });

  test("a write rule refusal names its rule, and an unreadable configuration is logged", async () => {
    const denied = new WriteRuleDenied("config_unreadable", "writes are refused", "line 3: bad toml");
    const { deps: d, lines } = deps({
      attached: () => {
        throw denied;
      },
    });
    const caught = await createManagementHandler(d)(call("getContext", { root: "/p" }), true).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(MethodError);
    expect((caught as MethodError).toWire()).toMatchObject({
      code: "write_rule_denied",
      details: { rule: "config_unreadable" },
    });
    expect(lines).toContain("[archer] write refused: the global archer.toml could not be read: line 3: bad toml");
  });

  test("other failures pass through unchanged", async () => {
    const own = new MethodError("project_not_attached", "no");
    const caught = await createManagementHandler(deps().deps)(call("getContext", { root: "/p" }), true).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(MethodError);
    expect((caught as MethodError).toWire().code).toBe(own.toWire().code);
  });

  test("collections are read when a request is answered, not when the handler is made", async () => {
    const restoringStatus = new Map();
    const handle = createManagementHandler(deps({ restoringStatus }).deps);
    expect(await handle(call("listProjects"), true)).toEqual({ projects: [] });
    restoringStatus.set("/p", { root: "/p", name: "p", url: "u" });
    expect(await handle(call("listProjects"), true)).toEqual({ projects: [{ root: "/p", name: "p", url: "u" }] });
  });

  test("the browser is opened once per service, on the first present that may open it", async () => {
    const opened: string[] = [];
    const state = {
      url: "http://x/projects/p/",
      reload: async () => {},
      present: () => ({ presentationId: "pr" }),
    };
    const handle = createManagementHandler(
      deps({
        openBrowser: true,
        options: { browserOpener: async (url: string) => void opened.push(url) },
        attached: () => state as never,
      }).deps,
    );
    await handle(call("present", { root: "/p", viewId: "v", openBrowser: false }), true);
    expect(opened).toEqual([]);
    await handle(call("present", { root: "/p", viewId: "v" }), true);
    await handle(call("present", { root: "/p", viewId: "v" }), true);
    expect(opened).toEqual(["http://x/projects/p/"]);
  });

  test("access links carry the issued token on this service's origin", async () => {
    const handle = createManagementHandler(
      deps({ grants: { issue: () => ({ id: "g", token: "T", label: "l" }) } as never }).deps,
    );
    expect(await handle(call("issueAccess", { label: "l" }), true)).toMatchObject({
      url: "http://127.0.0.1:4321/projects/?token=T",
    });
  });
});
