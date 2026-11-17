// Where the keyboard goes on the sequence canvas, what a message is called,
// and how far the camera has to move to show what the keyboard is standing on.
//
// Pure, for the reason `keyboard-nav.test.ts` is: jsdom does no layout, so the
// decisions are tested against real layout coordinates here and the canvas
// test only checks that they are wired up.
import { describe, expect, it } from "vitest";
import { projectEnvelope, type ProjectedSequence } from "../src/diagrams/projection";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import {
  messageAccessibleName,
  revealPanZoom,
  sequenceMove,
  sequenceStopId,
  targetBox,
} from "../src/diagrams/sequence-nav";
import { sequenceSelectionModel } from "../src/selection/sequence-selection";
import { loadValidFixture } from "./fixtures";

function view(): ProjectedSequence {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return projection.view;
}

// client | server | db; msg-0 client->server, msg-1 server->db, msg-2
// db->server, msg-3 server->client (in `alt`), msg-4 server->client (in `alt`).
const layout: SequenceLayoutResult = computeSequenceLayout(view());
const participant = (id: string) => ({ channel: "participants" as const, id });
const message = (id: string) => ({ channel: "messages" as const, id });

describe("participants: Left and Right walk the columns", () => {
  it("moves to the neighbouring participant", () => {
    expect(sequenceMove(layout, participant("client"), "right")).toEqual(participant("server"));
    expect(sequenceMove(layout, participant("db"), "left")).toEqual(participant("server"));
  });

  it("wraps at either end rather than dead-ending", () => {
    expect(sequenceMove(layout, participant("db"), "right")).toEqual(participant("client"));
    expect(sequenceMove(layout, participant("client"), "left")).toEqual(participant("db"));
  });
});

describe("messages: Up and Down walk source order", () => {
  it("steps through the messages in the order they were written, into and out of a fragment", () => {
    const visited = ["msg-0"];
    for (let i = 0; i < 4; i += 1) {
      const next = sequenceMove(layout, message(visited[visited.length - 1]), "down");
      visited.push(next!.id);
      expect(next!.channel).toBe("messages");
    }
    expect(visited).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  it("wraps at either end rather than dead-ending", () => {
    expect(sequenceMove(layout, message("msg-4"), "down")).toEqual(message("msg-0"));
    expect(sequenceMove(layout, message("msg-0"), "up")).toEqual(message("msg-4"));
  });
});

describe("the cross keys follow the drawing instead of dead-ending", () => {
  it("Left/Right on a message goes to the participant at that end of the arrow", () => {
    // msg-2 is drawn right-to-left (db -> server): Left is where it is drawn
    // to end on screen, not where it is sent from.
    expect(sequenceMove(layout, message("msg-2"), "left")).toEqual(participant("server"));
    expect(sequenceMove(layout, message("msg-2"), "right")).toEqual(participant("db"));
    expect(sequenceMove(layout, message("msg-0"), "left")).toEqual(participant("client"));
  });

  it("Down on a participant goes to the first message it takes part in, Up to the last", () => {
    expect(sequenceMove(layout, participant("db"), "down")).toEqual(message("msg-1"));
    expect(sequenceMove(layout, participant("db"), "up")).toEqual(message("msg-2"));
    expect(sequenceMove(layout, participant("client"), "up")).toEqual(message("msg-4"));
  });

  it("returns to the message the keyboard came from, when that message touches the participant", () => {
    expect(sequenceMove(layout, participant("server"), "down", { messageId: "msg-2" })).toEqual(message("msg-2"));
    // ...but not to one that has nothing to do with this column.
    expect(sequenceMove(layout, participant("db"), "down", { messageId: "msg-0" })).toEqual(message("msg-1"));
  });

  it("still goes somewhere from a participant no message touches", () => {
    const lonely: SequenceLayoutResult = {
      ...layout,
      participants: [...layout.participants, { ...layout.participants[0], id: "idle", label: "Idle" }],
    };
    expect(sequenceMove(lonely, participant("idle"), "down")).toEqual(message("msg-0"));
    expect(sequenceMove(lonely, participant("idle"), "up")).toEqual(message("msg-4"));
  });

  it("answers null only when there is nowhere at all to go", () => {
    const empty: SequenceLayoutResult = { ...layout, messages: [] };
    expect(sequenceMove(empty, participant("client"), "down")).toBeNull();
    const single: SequenceLayoutResult = { ...layout, participants: [layout.participants[0]] };
    expect(sequenceMove(single, participant("client"), "right")).toBeNull();
  });
});

describe("the roving stop", () => {
  it("is the first item until something has been focused", () => {
    expect(sequenceStopId(layout.participants, null)).toBe("client");
    expect(sequenceStopId(layout.messages, null)).toBe("msg-0");
  });

  it("stays where the user left it, and falls back when a redraw removed it", () => {
    expect(sequenceStopId(layout.messages, "msg-3")).toBe("msg-3");
    expect(sequenceStopId(layout.messages, "msg-99")).toBe("msg-0");
    expect(sequenceStopId([], "msg-0")).toBeNull();
  });
});

describe("what a message is called", () => {
  it("names both ends by label, then the text", () => {
    expect(messageAccessibleName(layout.messages[0], layout.participants)).toBe("Client to Server: POST /login");
    expect(messageAccessibleName(layout.messages[2], layout.participants)).toBe("Database to Server: user record");
  });

  it("drops the colon when there is no text, and never falls back to nothing", () => {
    expect(messageAccessibleName({ ...layout.messages[0], label: undefined }, layout.participants)).toBe(
      "Client to Server",
    );
    expect(messageAccessibleName({ ...layout.messages[0], label: "" }, layout.participants)).toBe("Client to Server");
  });
});

describe("bringing the focused element into view", () => {
  const viewport = { width: 800, height: 600 };

  it("leaves the camera alone when the element is already on screen", () => {
    const panZoom = { x: 20, y: 20, scale: 1 };
    const box = targetBox(layout, message("msg-0"))!;
    expect(revealPanZoom(panZoom, box, viewport)).toBe(panZoom);
  });

  it("pans just far enough to show an element below the fold, without changing the scale", () => {
    const panZoom = { x: 20, y: -2000, scale: 1 };
    const box = targetBox(layout, message("msg-0"))!;
    const next = revealPanZoom(panZoom, box, viewport);
    expect(next.scale).toBe(1);
    expect(next.x).toBe(20);
    const top = box.y * next.scale + next.y;
    const bottom = (box.y + box.height) * next.scale + next.y;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(viewport.height);
  });

  it("pans horizontally for an element off to the side", () => {
    const panZoom = { x: 3000, y: 20, scale: 1 };
    const box = targetBox(layout, participant("db"))!;
    const next = revealPanZoom(panZoom, box, viewport);
    expect(next.y).toBe(20);
    expect((box.x + box.width) * next.scale + next.x).toBeLessThanOrEqual(viewport.width);
    expect(box.x * next.scale + next.x).toBeGreaterThanOrEqual(0);
  });

  it("does nothing for a viewport that has not been measured", () => {
    const panZoom = { x: 3000, y: 3000, scale: 1 };
    const box = targetBox(layout, participant("db"))!;
    expect(revealPanZoom(panZoom, box, { width: 0, height: 0 })).toBe(panZoom);
  });
});

describe("the selectable model of a sequence view", () => {
  it("publishes participants as nodes and every message, nested ones included, as an edge", () => {
    const model = sequenceSelectionModel(view());
    expect([...model.nodeDetails.keys()]).toEqual(["client", "server", "db"]);
    expect(model.nodeDetails.get("db")).toEqual({ label: "Database" });
    expect([...model.edgeDetails.keys()]).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(model.edgeDetails.get("msg-0")).toEqual({
      source: "client",
      target: "server",
      label: "POST /login",
    });
    // Fragments are frames, not things to select.
    expect(model.edgeDetails.has("frag-0")).toBe(false);
    expect(model.nodeDetails.has("frag-0")).toBe(false);
  });

  it("ignores an event type it does not know, rather than throwing", () => {
    const base = view();
    const withNote = {
      ...base,
      events: [{ type: "note", id: "note-0", text: "later" }, ...base.events],
    } as unknown as ProjectedSequence;
    const model = sequenceSelectionModel(withNote);
    expect([...model.edgeDetails.keys()]).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });
});
