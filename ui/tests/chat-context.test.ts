// Where a chat message was sent from: the page's route and the project-relative file, in the service's bounds.
import { describe, expect, it } from "vitest";
import { chatContext } from "../src/chat/chat-context";
import { MAX_CONTEXT_DOCUMENT_CHARS, MAX_CONTEXT_PAGE_CHARS } from "../src/comments/contract";

describe("chatContext", () => {
  it("names the page, and the file on a diagram or note page", () => {
    expect(chatContext("/projects/shop/", undefined)).toEqual({ page: "/projects/shop/" });
    expect(chatContext("/projects/shop/notes/auth.md", "notes/auth.md")).toEqual({
      page: "/projects/shop/notes/auth.md",
      document: "notes/auth.md",
    });
    expect(chatContext("/projects/shop/", null)).toEqual({ page: "/projects/shop/" });
    expect(chatContext("/projects/shop/", "")).toEqual({ page: "/projects/shop/" });
  });
  it("is nothing without a page, so the message goes without a context", () => {
    expect(chatContext(null)).toBeUndefined();
    expect(chatContext("")).toBeUndefined();
  });
  it("cuts to the service's bounds and drops control characters, rather than being refused", () => {
    const long = chatContext("/" + "a".repeat(MAX_CONTEXT_PAGE_CHARS * 2), "d".repeat(MAX_CONTEXT_DOCUMENT_CHARS * 2))!;
    expect([...long.page]).toHaveLength(MAX_CONTEXT_PAGE_CHARS);
    expect([...long.document!]).toHaveLength(MAX_CONTEXT_DOCUMENT_CHARS);
    expect(chatContext("/a\nb\u0000c\u007f")).toEqual({ page: "/abc" });
  });
});
