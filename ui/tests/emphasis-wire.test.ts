// The page reads the SERVER'S bytes, not a mock of them.
//
// Every other emphasis test in this directory feeds the parser a payload
// written from the same prose the parser was written from, so the two agree by
// construction and would go on agreeing through any rename the server made.
// The half that renders and the half that publishes were built in parallel and
// merged: nothing but this file has ever put one's output into the other's
// input.
//
// The fixture is what the service serves:
// `ts/test/service/emphasis-wire.test.ts` asserts it is still what the
// service emits. So a wire change fails there, and a wire change the
// page cannot follow fails HERE -- which matters because the page's own
// failure mode is silent: `parseEmphasisSnapshot` drops what it cannot read and
// logs, leaving a diagram with nothing lit up and a green build.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPHASIS_SLOTS,
  EMPHASIS_SPEEDS,
  EMPHASIS_STYLES,
  assignEmphasis,
  paletteClass,
  parseEmphasisSnapshot,
  styleClass,
  type EmphasisAssignment,
} from "../src/emphasis/contract";

const WIRE = new URL("../../fixtures/protocol/emphasis-wire.json", import.meta.url);

const STYLESHEET = new URL("../src/styles.css", import.meta.url);

function wire(): unknown {
  return JSON.parse(readFileSync(WIRE, "utf8"));
}

function assignments(): EmphasisAssignment[] {
  const snapshot = parseEmphasisSnapshot(wire());
  if (snapshot === undefined) {
    throw new Error("the served snapshot did not parse");
  }
  return snapshot.emphases.flatMap((emphasis) => {
    const { nodes, edges } = assignEmphasis(emphasis);
    return [...nodes.values(), ...edges.values()];
  });
}

describe("the emphasis wire, as the server actually serves it", () => {
  // The envelope is what the SSE event, the HTTP route and the tool result all
  // carry, so getting it wrong loses every emphasis on every transport at once.
  it("is an envelope the page recognises", () => {
    const snapshot = parseEmphasisSnapshot(wire());
    expect(snapshot).toBeDefined();
    expect(snapshot?.viewId).toBe("ctx");
  });

  // Not "at least one": the parser is atomic per emphasis and the snapshot
  // reader drops a member it cannot read, so a partial pass is the exact
  // failure this file exists to catch.
  it("loses no emphasis and no group on the way in", () => {
    const served = wire() as { emphases: { groups: unknown[] }[] };
    const snapshot = parseEmphasisSnapshot(served);
    expect(snapshot?.emphases).toHaveLength(served.emphases.length);
    snapshot?.emphases.forEach((emphasis, index) => {
      expect(emphasis.groups).toHaveLength(served.emphases[index].groups.length);
    });
  });

  // The server OMITS an absent optional rather than sending null. A page that
  // required the key would drop the group; one that required null would drop it
  // too. Both spellings are in the fixture.
  it("reads a group whose optional prose was left out", () => {
    const snapshot = parseEmphasisSnapshot(wire());
    const groups = snapshot?.emphases.flatMap((emphasis) => emphasis.groups) ?? [];
    const bare = groups.find((group) => group.id === "proposed");
    expect(bare?.label).toBe("Refund queue (proposed)");
    expect(bare?.description).toBe("");

    const written = groups.find((group) => group.id === "now");
    expect(written?.label).toBe("What is there now");
    expect(written?.description).toBe("Both optional strings present.");
  });

  // `speed` is the one optional field with a default on both sides, and the two
  // halves picked it independently.
  it("agrees about pace: absent on a highlight, defaulted on a flow", () => {
    const groups = parseEmphasisSnapshot(wire())?.emphases.flatMap((emphasis) => emphasis.groups) ?? [];
    expect(groups.find((group) => group.id === "first")?.speed).toBeNull();
    expect(groups.find((group) => group.id === "unpaced")?.speed).toBe("normal");
    expect(groups.find((group) => group.id === "slow")?.speed).toBe("slow");
  });

  // A value the server can send and the page has never heard of is a dropped
  // emphasis, silently. The fixture is asserted to carry the whole advertised
  // vocabulary on the Rust side, so this is that list reaching this side.
  it("carries every value both halves know, and no value only one of them knows", () => {
    const seen = assignments();
    // ADR 0030: three slots, never amber, and nothing is "proposed" on the wire any more.
    expect(new Set(seen.map((each) => each.palette))).toEqual(new Set(EMPHASIS_SLOTS));
    expect(new Set(seen.map((each) => each.style))).toEqual(new Set(EMPHASIS_STYLES));
    expect(new Set(seen.map((each) => each.state))).toEqual(new Set(["existing"]));
    expect(new Set(seen.flatMap((each) => (each.speed === null ? [] : [each.speed])))).toEqual(
      new Set(EMPHASIS_SPEEDS),
    );
  });

  // ADR 0015 keeps browser protocol 1 stable, and a page from before ADR 0030
  // may still be open when the service is upgraded. That page dropped a whole
  // emphasis for a group without a known palette, or with an unknown state:
  // the service must therefore keep sending both, derived, on every group.
  it("still carries what a page from before ADR 0030 required of every group", () => {
    const served = wire() as { emphases: { groups: Record<string, unknown>[] }[] };
    const groups = served.emphases.flatMap((emphasis) => emphasis.groups);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(["teal", "amber", "violet", "coral"]).toContain(group.palette);
      expect(["existing", "proposed"]).toContain(group.state);
    }
  });

  // The last link in the chain: enum -> class -> rule. A palette the stylesheet
  // has no rule for renders as the fallback hue, so two groups the agent
  // deliberately distinguished come out the same colour -- a wrong picture
  // rather than an absent one.
  it("names a class the stylesheet actually styles, for every value it carries", () => {
    const css = readFileSync(STYLESHEET, "utf8");
    const seen = assignments();
    const required = new Set([
      ...seen.map((each) => paletteClass(each.palette)),
      ...seen.map((each) => styleClass(each.style)),
      // `existing` is the unstyled default: it is the absence of the proposed
      // treatment, not a treatment of its own.
    ]);
    for (const className of required) {
      expect(css, `${className} is emitted onto elements but styled nowhere`).toContain(`.${className}`);
    }
  });
});
