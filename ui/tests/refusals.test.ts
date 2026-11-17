import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeRefusal, REFUSAL_CODES } from "../src/authoring/refusals";

const TS = resolve(__dirname, "../../ts/src");

/** Every code key in the server's HTTP status map. */
function statusMapCodes(): string[] {
  const text = readFileSync(resolve(TS, "service/authoring-http.ts"), "utf8");
  const map = /AUTHORING_HTTP_STATUS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
  return [...map.matchAll(/(?:^|[\s,])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\d{3}/g)].map((m) => m[1]!);
}
/** Every `edit_*` code the five editors (and the dispatcher) can return. */
function editorCodes(): string[] {
  const dir = resolve(TS, "authoring");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => /-edit\.ts$/.test(f))) {
    for (const m of readFileSync(resolve(dir, file), "utf8").matchAll(/["'](edit_[a-z_]+)["']/g)) found.add(m[1]!);
  }
  return [...found];
}

describe("describeRefusal", () => {
  it("says why an async message can't be two-way when the Arrow control was refused (MU)", () => {
    expect(describeRefusal("edit_invalid_message_kind", { edit: "change-arrow" }).message).toMatch(
      /async message has one arrowhead only.*Message or Reply/,
    );
    expect(describeRefusal("edit_invalid_message_kind", { edit: "retarget-edge" }).message).toMatch(
      /two-way message can’t be async/,
    );
    expect(describeRefusal("edit_invalid_message_kind").message).toMatch(/message type isn’t available/);
  });
  it("has copy for every code in the server's status map", () => {
    const codes = statusMapCodes();
    expect(codes.length).toBeGreaterThan(80);
    expect(codes.filter((c) => !describeRefusal(c).known)).toEqual([]);
  });
  // Codes batch S may add or retire (edit_delete_last_element, edit_fragment_unsupported) are allowed extras below.
  it("has copy for every code the editors can return", () => {
    const codes = editorCodes();
    expect(codes.length).toBeGreaterThan(50);
    expect(codes.filter((c) => !describeRefusal(c).known)).toEqual([]);
  });
  it("lists no code the server doesn't know (stale copy)", () => {
    const known = new Set([
      ...statusMapCodes(),
      ...editorCodes(),
      "authoring_body_too_large",
      "method_not_allowed",
      "edit_delete_last_element",
      "edit_fragment_unsupported",
    ]);
    expect(REFUSAL_CODES.filter((c) => !known.has(c))).toEqual([]);
  });
  it("never puts the raw code in the main text, only in details", () => {
    for (const code of REFUSAL_CODES) {
      const r = describeRefusal(code, {
        name: "Cache",
        count: 2,
        existingId: "a--b",
        diagnostic: { message: "boom", line: 3 },
      });
      expect(r.message, code).not.toMatch(/\bedit_|\bauthoring_|_[a-z]+_[a-z]+/);
      expect(r.details).toContain(code);
      expect(r.what.length, code).toBeGreaterThan(8);
      expect(r.todo.length, code).toBeGreaterThan(4);
      expect(r.message, code).not.toMatch(/undefined|\[object/);
    }
  });
  it("offers to delete the connections first for a referenced node", () => {
    const r = describeRefusal("edit_delete_referenced_node", { name: "Cache", count: 2 });
    expect(r.what).toBe("“Cache” still has 2 connections.");
    expect(r.todo).toMatch(/Delete it together with its connections/);
    expect(r.actions).toEqual([{ kind: "delete-connections", label: "Delete it and its connections" }]);
    expect(describeRefusal("edit_delete_referenced_node").what).toBe("This shape still has connections.");
    expect(describeRefusal("edit_delete_referenced_node", { count: 1 }).what).toContain("1 connection.");
  });
  it("points at the existing relationship, never dropping existingId", () => {
    const r = describeRefusal("edit_relationship_exists", { existingId: "client--api" });
    expect(r.what).toContain("client → api");
    expect(r.actions).toEqual([{ kind: "show-existing", label: "Show the existing one", id: "client--api" }]);
    expect(describeRefusal("edit_relationship_exists").actions).toEqual([]);
  });
  it("passes the compiler's first diagnostic through for edit_requires_valid_*", () => {
    for (const family of ["flowchart", "c4", "er", "state", "sequence"]) {
      const r = describeRefusal(`edit_requires_valid_${family}`, {
        diagnostic: { message: "every edge needs a stable ID", line: 4 },
      });
      expect(r.what).toContain("Line 4: every edge needs a stable ID");
      expect(r.actions[0]!.kind).toBe("open-source");
      expect(r.details).toContain("every edge needs a stable ID");
    }
    expect(describeRefusal("edit_requires_valid_er").what).toMatch(/does not handle yet/);
  });
  it("treats a no-op move as information, not an error", () => {
    expect(describeRefusal("edit_move_same_message").severity).toBe("info");
  });
  it("falls back for an unknown code without exposing it in the text", () => {
    const r = describeRefusal("edit_brand_new_thing");
    expect(r.known).toBe(false);
    expect(r.message).not.toContain("edit_brand_new_thing");
    expect(r.details).toContain("edit_brand_new_thing");
    expect(r.actions.map((a) => a.kind)).toEqual(["retry", "open-source"]);
    expect(describeRefusal("toString").known).toBe(false);
  });
});
