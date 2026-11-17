import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { browserAuthor, cumulativePage } from "../application/cumulative-review-support.ts";
import { cleanUp, FLOW, project, service } from "../service/support.ts";
import { connect } from "./support.ts";
afterEach(cleanUp);
const structured = (result: Record<string, unknown>) => result.structuredContent as Record<string, unknown>;

test("public MCP schemas expose cumulative parts and summary without acquiring a service on tools/list", async () => {
  const root = project();
  let acquisitions = 0;
  const mcp = await connect({
    cwd: root,
    findService: async () => {
      acquisitions++;
      return null;
    },
  });
  try {
    const tools = (await mcp.client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "list_changes")!.inputSchema.properties).toHaveProperty("reviewCursor");
    expect(tools.find((tool) => tool.name === "read_change")!.inputSchema.properties).toHaveProperty("part.enum", [
      "before",
      "after",
      "baseline",
      "latest",
      "diff",
    ]);
    expect(tools.find((tool) => tool.name === "resolve_change")!.inputSchema.properties).toHaveProperty(
      "summary.maxLength",
      2048,
    );
    expect(acquisitions).toBe(0);
  } finally {
    await mcp.close();
  }
});

test("real MCP re-hints cumulative revisions and health changes while preserving exact primary output", async () => {
  const { svc, state } = await service(),
    admin = await connectService(svc.socketPath),
    root = project(),
    browser = await browserAuthor(svc, admin, root);
  let starts = 0,
    finds = 0;
  const mcp = await connect({
      cwd: root,
      findService: () => {
        finds++;
        return connectService(svc.socketPath);
      },
      ensureService: async () => {
        starts++;
        return connectService(svc.socketPath);
      },
    }),
    app = createApplication({ cwd: root });
  const call = async () => {
    const primary = await app.call("list_diagrams", {}),
      result = await mcp.client.callTool({ name: "list_diagrams", arguments: {} });
    expect(result.structuredContent).toEqual(primary.structured);
    expect((result.content as { text: string }[])[0]).toEqual({ type: "text", text: primary.text });
    return result.content as { text: string }[];
  };
  try {
    await mcp.client.listTools();
    expect(finds).toBe(0);
    expect(await call()).toHaveLength(1);
    await browser.save(FLOW.replace("Client", "Second"));
    const review = (await admin.call("listChanges", { root })).cumulativeReviews!.reviews[0]!;
    expect((await call())[1]!.text).toContain(review.reviewId);
    expect(await call()).toHaveLength(1);
    await browser.save(FLOW.replace("Client", "Third"));
    const revised = await call();
    expect(revised[1]!.text).toContain("2 saves");
    expect(revised[1]!.text).toContain("rev 2");
    expect(await call()).toHaveLength(1);
    await browser.save(FLOW);
    const netNone = await call();
    expect(netNone[1]!.text).toContain("net none");
    expect(netNone[1]!.text).toContain("3 saves");
    expect(Buffer.byteLength(netNone[1]!.text)).toBeLessThanOrEqual(1024);
    const read = await mcp.client.callTool({
      name: "read_change",
      arguments: { changeId: review.reviewId, part: "baseline" },
    });
    expect(structured(read).source).toMatchObject({ text: FLOW });
    expect(read.content).toHaveLength(1);
    await expect(
      mcp.client.callTool({
        name: "resolve_change",
        arguments: { changeId: review.reviewId, expectedReviewRevision: 3, disposition: "cleared" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    const cleared = await mcp.client.callTool({
      name: "resolve_change",
      arguments: {
        reviewId: review.reviewId,
        expectedReviewRevision: 3,
        disposition: "cleared",
        summary: "The three label Saves return to the baseline; understood with no remaining clarifications.",
      },
    });
    expect(structured(cleared).review).toMatchObject({ state: "cleared", reviewRevision: 4 });
    expect(cleared.content).toHaveLength(1);
    expect(await call()).toHaveLength(1);
    await browser.save(FLOW.replace("Client", "Fourth"));
    const reopened = await call();
    expect(reopened[1]!.text).toContain("1 saves");
    expect(reopened[1]!.text).not.toContain(review.reviewId);
    writeFileSync(join(state, "runtime/authoring/index.json"), "{corrupt");
    const degraded = await call();
    expect(degraded[1]!.text).toContain("cumulative review feed unavailable");
    expect(await call()).toHaveLength(1);
    expect(starts).toBe(0);
  } finally {
    app.close();
    await mcp.close();
    admin.close();
  }
});

test("real MCP shares three hint headers across cumulative and legacy and never leaks foreign or held reviews", async () => {
  const { svc } = await service(),
    admin = await connectService(svc.socketPath),
    root = project(),
    other = project(),
    browser = await browserAuthor(svc, admin, root),
    foreign = await browserAuthor(svc, admin, other);
  await foreign.save(FLOW.replace("Client", "Foreign private label"));
  const foreignId = (await admin.call("listChanges", { root: other })).cumulativeReviews!.reviews[0]!.reviewId;
  const mcp = await connect({ cwd: root, findService: () => connectService(svc.socketPath) });
  try {
    expect((await mcp.client.callTool({ name: "list_diagrams", arguments: {} })).content).toHaveLength(1);
    await browser.save(FLOW.replace("Client", "First"));
    await browser.publish("diagrams/second.mmd", FLOW.replace("Client", "Second"));
    for (let i = 0; i < 3; i++)
      svc.changes.admit({
        operationId: randomBytes(16).toString("hex"),
        projectRoot: root,
        format: "mermaid",
        origin: "browser_editor",
        target: { kind: "draft", id: "legacy-" + i },
        eventKind: "draft.saved",
        before: null,
        after: Buffer.from("private"),
      });
    const result = await mcp.client.callTool({ name: "list_diagrams", arguments: {} }),
      hint = (result.content as { text: string }[])[1]!.text;
    expect(hint.split("\n").filter((line) => /^(rev_|chg_)/u.test(line))).toHaveLength(3);
    expect(hint.split("\n").filter((line) => line.startsWith("rev_"))).toHaveLength(2);
    expect(hint).toContain("2 omitted");
    expect(hint).not.toContain(foreignId);
    expect(hint).not.toContain("Foreign private label");
    expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(1024);
    const explicit = await mcp.client.callTool({ name: "list_changes", arguments: {} });
    expect(explicit.content).toHaveLength(1);
    expect(cumulativePage(structured(explicit).cumulativeReviews).reviews).toHaveLength(2);
  } finally {
    await mcp.close();
    admin.close();
  }
  const heldRoot = project();
  writeFileSync(
    join(heldRoot, "archer.toml"),
    readFileSync(join(heldRoot, "archer.toml"), "utf8") + '\n[feedback]\nchanges = "manual"\n',
  );
  const heldAdmin = await connectService(svc.socketPath),
    heldBrowser = await browserAuthor(svc, heldAdmin, heldRoot);
  await heldBrowser.save(FLOW.replace("Client", "Held private label"));
  const heldMcp = await connect({ cwd: heldRoot, findService: () => connectService(svc.socketPath) });
  try {
    expect((await heldMcp.client.callTool({ name: "list_diagrams", arguments: {} })).content).toHaveLength(1);
    const listed = await heldMcp.client.callTool({ name: "list_changes", arguments: {} });
    expect(cumulativePage(structured(listed).cumulativeReviews).reviews[0]).toMatchObject({ delivery: "held" });
  } finally {
    await heldMcp.close();
    heldAdmin.close();
  }
});
