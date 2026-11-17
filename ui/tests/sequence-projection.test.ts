import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectEnvelope } from "../src/diagrams/projection";

const sequenceFixturePath = fileURLToPath(
  new URL("../../fixtures/protocol/valid/minimal-sequence.json", import.meta.url),
);

function loadSequenceFixture(): unknown {
  return JSON.parse(readFileSync(sequenceFixturePath, "utf8"));
}

describe("sequence projection", () => {
  it("projects a sequence envelope into a sequence-type result with 3 participants", () => {
    const result = projectEnvelope(loadSequenceFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.type).toBe("sequence");
    if (result.type !== "sequence") return;

    expect(result.view.viewId).toBe("auth-flow");
    expect(result.view.kind).toBe("sequence");
    expect(result.view.title).toBe("Authentication flow");
    expect(result.view.modelType).toBe("sequence-trace");
    expect(result.view.participants).toHaveLength(3);
    expect(result.view.participants.map((p) => p.id)).toEqual(["client", "server", "db"]);
    // Top-level events: msg-0, activate, msg-1, msg-2, frag-0, deactivate = 6
    expect(result.view.events).toHaveLength(6);
  });

  it("preserves participant order from the fixture", () => {
    const result = projectEnvelope(loadSequenceFixture());
    expect(result.ok).toBe(true);
    if (!result.ok || result.type !== "sequence") return;

    expect(result.view.participants[0].label).toBe("Client");
    expect(result.view.participants[1].label).toBe("Server");
    expect(result.view.participants[2].label).toBe("Database");
  });

  it("extracts message events with correct fields", () => {
    const result = projectEnvelope(loadSequenceFixture());
    expect(result.ok).toBe(true);
    if (!result.ok || result.type !== "sequence") return;

    const messages = result.view.events.filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThanOrEqual(3);

    const msg0 = messages.find((e) => e.type === "message" && e.id === "msg-0");
    expect(msg0).toBeDefined();
    if (msg0 && msg0.type === "message") {
      expect(msg0.from).toBe("client");
      expect(msg0.to).toBe("server");
      expect(msg0.label).toBe("POST /login");
      expect(msg0.kind).toBe("sync");
    }
  });

  it("extracts fragment events with sections", () => {
    const result = projectEnvelope(loadSequenceFixture());
    expect(result.ok).toBe(true);
    if (!result.ok || result.type !== "sequence") return;

    const fragments = result.view.events.filter((e) => e.type === "fragment");
    expect(fragments).toHaveLength(1);

    const frag = fragments[0];
    if (frag.type === "fragment") {
      expect(frag.id).toBe("frag-0");
      expect(frag.kind).toBe("alt");
      expect(frag.label).toBe("Credentials valid?");
      expect(frag.sections).toHaveLength(2);
      expect(frag.sections[0].label).toBe("Valid");
      expect(frag.sections[0].events).toHaveLength(1);
    }
  });

  it("graph envelopes still return graph-type results", () => {
    const graphFixturePath = fileURLToPath(
      new URL("../../fixtures/protocol/valid/minimal-architecture.json", import.meta.url),
    );
    const fixture = JSON.parse(readFileSync(graphFixturePath, "utf8"));
    const result = projectEnvelope(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.type).toBe("graph");
    if (result.type !== "graph") return;
    expect(result.view.nodes).toBeDefined();
  });

  it("produces deterministic output for sequence input", () => {
    const fixture = loadSequenceFixture();
    const result1 = projectEnvelope(fixture);
    const result2 = projectEnvelope(fixture);
    expect(result1).toEqual(result2);
  });
});
