// A note's author reaches its file row, so the Notes view can show and sort by it.
import { describe, expect, it } from "vitest";
import { parseFileFacts } from "../src/app/file-facts";

describe("a note's author", () => {
  it("is kept when the service sends agent or person", () => {
    expect(parseFileFacts({ author: "agent" }).author).toBe("agent");
    expect(parseFileFacts({ author: "person" }).author).toBe("person");
  });
  it("is dropped when it is anything else", () => {
    expect(parseFileFacts({ author: "someone" })).not.toHaveProperty("author");
    expect(parseFileFacts({ author: 3 })).not.toHaveProperty("author");
  });
});
