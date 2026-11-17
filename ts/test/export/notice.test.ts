import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import { expect, test } from "vitest";
import { exportDiagram } from "../../src/export/index.ts";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { testResources } from "./resources.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const notice = "Copyright © Authors — 鳥.\n\nKeep <all> terms & literal ]]> text.\n";
async function drawing() {
  const source = "flowchart LR\n a[Client] reads@--> b[API]\n";
  const compiled = await compile(source);
  expect(compiled.model).not.toBeNull();
  return {
    schemaVersion: 2,
    revision: revisionOf(Buffer.from(source)),
    view: { id: "flow", kind: "freeform", title: "Flow" },
    model: compiled.model,
  };
}

test("local SVG export retains the full Unicode project notice as inert metadata", async () => {
  const result = await exportDiagram(await drawing(), {
    resources: await testResources(),
    projectNotice: notice,
  });
  const document = new JSDOM(new TextDecoder().decode(result.bytes), { contentType: "image/svg+xml" }).window.document;
  expect(document.querySelector("metadata#archer-project-notice")?.textContent).toBe(notice);
  expect(document.querySelector("[data-export-notice]")).toBeNull();
});

test("local PNG export embeds the complete project notice in an uncompressed UTF-8 iTXt chunk", async () => {
  const result = await exportDiagram(await drawing(), {
    resources: await testResources(),
    format: "png",
    projectNotice: notice,
  });
  const bytes = Buffer.from(result.bytes);
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    expect(bytes.readUInt32BE(at + 8 + length)).toBe(crc32(bytes.subarray(at + 4, at + 8 + length)));
    chunks.push({ type: bytes.toString("ascii", at + 4, at + 8), data: bytes.subarray(at + 8, at + 8 + length) });
    at += length + 12;
  }
  expect(chunks.at(-1)?.type).toBe("IEND");
  const text = chunks.find((chunk) => chunk.type === "iTXt");
  expect(text?.data.toString("utf8")).toBe(`Copyright\0\0\0\0\0${notice}`);
});

test("a requested visible notice caption is drawn below the diagram without truncating its terms", async () => {
  const envelope = await drawing(),
    resources = await testResources();
  const plain = await exportDiagram(envelope, { resources });
  const captioned = await exportDiagram(envelope, {
    resources,
    projectNotice: notice,
    noticeCaption: true,
  });
  const document = new JSDOM(new TextDecoder().decode(captioned.bytes), { contentType: "image/svg+xml" }).window
    .document;
  expect(document.querySelector("[data-export-notice]")?.textContent).toContain("Copyright © Authors — 鳥.");
  expect(document.querySelector("[data-export-notice]")?.textContent).toContain("Keep <all> terms & literal ]]> text.");
  expect(captioned.height).toBeGreaterThan(plain.height);
  expect(document.querySelector("metadata#archer-project-notice")?.textContent).toBe(notice);
});

test("an oversized unbroken caption refuses before layout while its full notice remains exportable as metadata", async () => {
  const envelope = await drawing(),
    resources = await testResources(),
    projectNotice = "x".repeat(1000);
  const metadata = await exportDiagram(envelope, { resources, projectNotice });
  expect(new TextDecoder().decode(metadata.bytes).includes(projectNotice)).toBe(true);
  const result = await exportDiagram(envelope, { resources, projectNotice, noticeCaption: true }).then(
    () => ({ code: "accepted" }),
    (error: { code: string }) => ({ code: error.code }),
  );
  expect(result).toEqual({ code: "export_notice_caption_limit" });
});

test("an oversized caption paragraph refuses before layout without losing metadata-only exports", async () => {
  const envelope = await drawing(),
    resources = await testResources(),
    projectNotice = "word ".repeat(300);
  const metadata = await exportDiagram(envelope, { resources, projectNotice });
  expect(new TextDecoder().decode(metadata.bytes).includes(projectNotice)).toBe(true);
  const result = await exportDiagram(envelope, { resources, projectNotice, noticeCaption: true }).then(
    () => ({ code: "accepted" }),
    (error: { code: string }) => ({ code: error.code }),
  );
  expect(result).toEqual({ code: "export_notice_caption_limit" });
});
