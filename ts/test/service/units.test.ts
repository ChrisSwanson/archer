// The service's small rules: slugs, the token check, the stream cap, and
// which selections are stored (ADR 0011).
import { describe, expect, test } from "vitest";
import type { DiagramEnvelope } from "../../src/model/index.ts";
import { acceptSelection, MAX_SELECTION_ELEMENTS, readerPresentationId } from "../../src/service/selection-check.ts";
import { MAX_EVENT_STREAMS, StreamCap } from "../../src/service/streams.ts";
import { tokenMatches } from "../../src/service/token.ts";
import { isLoopback } from "../../src/service/http.ts";
import { serviceDirs } from "../../src/service/paths.ts";

describe("serviceDirs", () => {
  test.each<[string, Record<string, string>, { stateDir: string; socketPath: string }]>([
    [
      "XDG dirs",
      { HOME: "/h", XDG_STATE_HOME: "/s", XDG_RUNTIME_DIR: "/run/u" },
      { stateDir: "/s/archer", socketPath: "/s/archer/archer.sock" },
    ],
    [
      "no runtime dir: the socket in the state dir",
      { HOME: "/h", XDG_STATE_HOME: "/s" },
      { stateDir: "/s/archer", socketPath: "/s/archer/archer.sock" },
    ],
    [
      "no XDG at all",
      { HOME: "/h" },
      { stateDir: "/h/.local/state/archer", socketPath: "/h/.local/state/archer/archer.sock" },
    ],
    [
      "relative XDG paths are ignored, as the spec says",
      { HOME: "/h", XDG_STATE_HOME: "s", XDG_RUNTIME_DIR: "r" },
      { stateDir: "/h/.local/state/archer", socketPath: "/h/.local/state/archer/archer.sock" },
    ],
  ])("%s", (_name, env, expected) => {
    expect(serviceDirs(env)).toMatchObject(expected);
  });
});

describe("isLoopback", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.4.5.6", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.1.2", false],
    ["::ffff:10.0.0.1", false],
    ["fe80::1", false],
    [undefined, false],
  ])("%s is %s", (address, expected) => {
    expect(isLoopback(address)).toBe(expected);
  });
});

describe("tokenMatches", () => {
  const token = "ab".repeat(32);
  test.each([
    [token, true],
    ["ab".repeat(31) + "ac", false],
    ["ab", false],
    ["", false],
    [token + "00", false],
  ])("%s is %s", (presented, expected) => {
    expect(tokenMatches(presented, token)).toBe(expected);
  });
});

describe("StreamCap", () => {
  test(`admits ${MAX_EVENT_STREAMS} streams, refuses the next, and admits again once one closes`, () => {
    expect(MAX_EVENT_STREAMS).toBe(32);
    const cap = new StreamCap();
    const releases = Array.from({ length: MAX_EVENT_STREAMS }, () => cap.acquire());
    expect(releases.every((r) => r !== null)).toBe(true);
    expect(cap.acquire()).toBeNull();
    releases[0]?.();
    releases[0]?.(); // releasing twice gives back one permit, not two
    expect(cap.open).toBe(MAX_EVENT_STREAMS - 1);
    expect(cap.acquire()).not.toBeNull();
    expect(cap.acquire()).toBeNull();
  });
});

describe("acceptSelection", () => {
  const REV = `sha256:${"1".repeat(64)}`;
  const OTHER_REV = `sha256:${"2".repeat(64)}`;
  const envelope = (viewId: string, revision = REV): DiagramEnvelope => ({
    schemaVersion: 2,
    view: { id: viewId, kind: "freeform", title: viewId },
    revision: revision as DiagramEnvelope["revision"],
    model: {
      type: "freeform-graph",
      nodes: [
        { id: "a", label: "Client" },
        { id: "b", label: "API" },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
      groups: [],
    },
  });
  const presented = { presentationId: "p1", viewId: "flow", revision: REV, envelope: envelope("flow") };
  const served = (viewId: string) =>
    viewId === "other" ? envelope("other") : viewId === "flow" ? envelope("flow") : null;
  const selection = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    viewId: "flow",
    revision: REV,
    presentationId: "p1",
    selectionRevision: 2,
    nodes: [{ id: "a", label: "anything the page says" }],
    edges: [{ id: "e1" }],
    ...extra,
  });

  test("a selection on the presentation is stored with the model's labels and endpoints", () => {
    expect(acceptSelection(selection(), { presentation: presented, served })).toEqual({
      ok: true,
      selection: {
        schemaVersion: 1,
        viewId: "flow",
        revision: REV,
        presentationId: "p1",
        selectionRevision: 2,
        nodes: [{ id: "a", label: "Client" }],
        edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
      },
    });
  });

  test("a selection on a tab the reader picked needs no presentation", () => {
    const result = acceptSelection(
      selection({ viewId: "other", presentationId: readerPresentationId("other"), nodes: [], edges: [] }),
      {
        presentation: null,
        served,
      },
    );
    expect(result).toMatchObject({ ok: true, selection: { viewId: "other", nodes: [], edges: [] } });
  });

  test.each<[string, Record<string, unknown>, boolean, number]>([
    ["an old revision of the presentation", { revision: OTHER_REV }, true, 409],
    ["a presentation id nobody issued", { presentationId: "p0" }, true, 409],
    ["a presentation stamp with nothing presented", {}, false, 409],
    [
      "a reader stamp at an old revision",
      { viewId: "other", presentationId: "reader:other", revision: OTHER_REV },
      true,
      409,
    ],
    ["a reader stamp for a view that does not exist", { viewId: "gone", presentationId: "reader:gone" }, true, 409],
    ["a reader stamp for another view", { viewId: "other", presentationId: "reader:flow" }, true, 409],
    ["a node the model does not hold", { nodes: [{ id: "ghost" }] }, true, 422],
    ["a node named twice", { nodes: [{ id: "a" }, { id: "a" }] }, true, 422],
    ["an edge id listed as a node", { nodes: [{ id: "e1" }] }, true, 422],
    ["too many nodes", { nodes: Array.from({ length: MAX_SELECTION_ELEMENTS + 1 }, () => ({ id: "a" })) }, true, 422],
    ["no viewId", { viewId: 3 }, true, 422],
    ["nodes that are not a list", { nodes: "a" }, true, 422],
  ])("refuses %s", (_name, extra, isPresented, status) => {
    const result = acceptSelection(selection(extra), { presentation: isPresented ? presented : null, served });
    expect(result).toMatchObject({ ok: false, status });
  });

  test("a selection that is not an object is refused as malformed", () => {
    expect(acceptSelection([1], { presentation: presented, served })).toMatchObject({ ok: false, status: 422 });
  });
});

// ARCHER_HOST chooses the address the page is served on (loopback when unset),
// so a person on another machine can open it; set it before the service starts.
describe("serve options from the environment", () => {
  test("ARCHER_HOST sets the bind address; unset or empty leaves the default", async () => {
    const { optionsFromEnv } = await import("../../src/service/foreground.ts");
    expect(optionsFromEnv({ ARCHER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(optionsFromEnv({}).host).toBeUndefined();
    expect(optionsFromEnv({ ARCHER_HOST: "" }).host).toBeUndefined();
  });
});

// The front doors and the service must find each other under the same
// overrides: ARCHER_STATE_DIR and ARCHER_SOCKET apply to both, or a service
// started with them is never found by the client that started it.
test("serviceDirs honours ARCHER_STATE_DIR and ARCHER_SOCKET", async () => {
  const { serviceDirs } = await import("../../src/service/paths.ts");
  const dirs = serviceDirs({ HOME: "/home/u", ARCHER_STATE_DIR: "/s/state", ARCHER_SOCKET: "/r/a.sock" });
  expect(dirs.stateDir).toBe("/s/state");
  expect(dirs.socketPath).toBe("/r/a.sock");
  expect(serviceDirs({ HOME: "/home/u", ARCHER_STATE_DIR: "/s/state" }).socketPath).toBe("/s/state/archer.sock");
});

// Unix socket paths are limited (about 104-108 bytes); a longer one fails deep
// inside listen() with a bare EINVAL. Say what is wrong and how to fix it.
test("a socket path too long for Unix sockets is refused with a fix", async () => {
  const { checkSocketPath } = await import("../../src/service/paths.ts");
  expect(() => checkSocketPath(`/tmp/${"x".repeat(120)}/archer.sock`)).toThrow(/ARCHER_SOCKET/);
  expect(() => checkSocketPath("/run/user/1000/archer/archer.sock")).not.toThrow();
});
