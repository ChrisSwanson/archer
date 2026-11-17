// The inventory payload arrives from two places -- `GET api/diagrams` and the
// `inventory` SSE event -- and both are untrusted JSON as far as the page is
// concerned. What matters is the failure MODE: a payload that is not an
// inventory must be rejected outright so the caller keeps the tabs it has,
// while a single malformed record must cost only its own tab. Dropping the
// whole payload over one bad entry would make every other registered diagram
// unreachable, which is the opposite of what a tab strip is for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVENTORY_SCHEMA_VERSION, kindLabel, parseInventory } from "../src/app/inventory";

const view = {
  id: "system-context",
  kind: "c4-context",
  title: "System context",
  registration: "durable",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// `schemaVersion` is what lets the wire shape change without an old page
// reading the new one as if nothing had happened. It was emitted by the server
// and documented here, and never read: a version-2 inventory was parsed as
// version 1, so whatever version 2 came to mean, this page would have drawn
// tabs from its own misreading of it.
describe("the inventory schema version", () => {
  it("is the version the server emits", () => {
    expect(INVENTORY_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    ["a later version", 2],
    ["an earlier version", 0],
    ["the right number as a string", "1"],
    ["null", null],
    ["nothing at all", undefined],
  ])("rejects a payload carrying %s, and says why", (_label, schemaVersion) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = schemaVersion === undefined ? { views: [view] } : { schemaVersion, views: [view] };

    // Rejected whole, the way a payload that is not an inventory is: the caller
    // keeps the tabs it has and reports the failure. Reading the records anyway
    // is the defect.
    expect(parseInventory(payload)).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("schemaVersion");
  });

  it("stays quiet about a payload that was never an inventory", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(parseInventory({ schemaVersion: 2, presentation: {} })).toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("parseInventory", () => {
  it("reads the frozen wire shape", () => {
    expect(parseInventory({ schemaVersion: 1, views: [view] })).toEqual([view]);
  });

  it("reads an empty registry as an empty inventory, not as a failure", () => {
    expect(parseInventory({ schemaVersion: 1, views: [] })).toEqual([]);
  });

  it("rejects a payload that is not an inventory", () => {
    for (const payload of [null, undefined, 1, "views", [], {}, { views: {} }]) {
      expect(parseInventory(payload), JSON.stringify(payload) ?? "undefined").toBeUndefined();
    }
  });

  it("drops only the records it cannot read", () => {
    const views = parseInventory({
      schemaVersion: 1,
      views: [
        view,
        { ...view, id: 7 },
        { ...view, registration: "pinned" },
        null,
        { id: "flow", kind: "data-flow", title: "Flow", registration: "ephemeral" },
      ],
    });

    expect(views?.map((v) => v.id)).toEqual(["system-context", "flow"]);
  });
});

describe("a view's model revision", () => {
  const revision = `sha256:${"c".repeat(64)}`;
  it("is read when it is a revision, which is what keys the view's thumbnail", () => {
    expect(
      parseInventory({ schemaVersion: 1, views: [{ ...view, modelRevision: revision }] })?.[0]?.modelRevision,
    ).toBe(revision);
  });
  it.each([7, "", "sha256:short", `SHA256:${"c".repeat(64)}`, `sha256:${"c".repeat(64)}/../x`])(
    "is dropped, alone, when it is %j",
    (value) => {
      const [read] = parseInventory({ schemaVersion: 1, views: [{ ...view, modelRevision: value }] }) ?? [];
      expect(read?.id).toBe(view.id);
      expect(read).not.toHaveProperty("modelRevision");
    },
  );
});

describe("kindLabel", () => {
  it.each([
    ["c4-context", "Context"],
    ["c4-container", "Containers"],
    ["c4-component", "Components"],
    ["c4-code", "Code"],
    ["data-flow", "Data flow"],
    ["sequence", "Sequence"],
  ])("says %s in words", (kind, label) => {
    expect(kindLabel(kind)).toBe(label);
  });

  it("has nothing to say about a diagram nobody gave a kind", () => {
    expect(kindLabel("freeform")).toBeUndefined();
  });

  it("never prints an identifier it does not recognise", () => {
    expect(kindLabel("some-future-kind")).toBeUndefined();
  });
});

// flows-r1 (S4): a registered diagram whose file is gone, and where it went when the service knows.
describe("a view whose file is gone", () => {
  it("reads the flag and the place it moved to", () => {
    const [read] =
      parseInventory({
        schemaVersion: 1,
        views: [{ ...view, sourceMissing: true, movedTo: { id: "context-v2", sourcePath: "diagrams/context-v2.mmd" } }],
      }) ?? [];
    expect(read?.sourceMissing).toBe(true);
    expect(read?.movedTo).toEqual({ id: "context-v2", sourcePath: "diagrams/context-v2.mmd" });
  });

  it.each([true, "yes", { id: 3, sourcePath: "x.mmd" }, { id: "x", sourcePath: "../x.mmd" }])(
    "drops a moved place it cannot read: %j",
    (movedTo) => {
      const [read] = parseInventory({ schemaVersion: 1, views: [{ ...view, sourceMissing: true, movedTo }] }) ?? [];
      expect(read).not.toHaveProperty("movedTo");
      expect(read?.sourceMissing).toBe(true);
    },
  );

  it("says nothing of a view whose file is there", () => {
    const [read] = parseInventory({ schemaVersion: 1, views: [{ ...view, sourceMissing: "no" }] }) ?? [];
    expect(read).not.toHaveProperty("sourceMissing");
  });
});
