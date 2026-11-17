import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanUp, project, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

test("local application exports load NOTICE.md for both SVG and PNG, including changed notice bytes", async () => {
  const root = project();
  const notice = "Copyright © Example.\n\nKeep every term & permission with the drawing.\n";
  write(root, "NOTICE.md", notice);
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    for (const format of ["svg", "png"] as const) {
      const result = await app.call("export_diagram", { viewId: "flow", format });
      const bytes = Buffer.from(String(result.structured.data), "base64");
      if (format === "svg") {
        expect(bytes.toString("utf8")).toContain('<metadata id="archer-project-notice">Copyright © Example.');
        expect(bytes.toString("utf8")).toContain("Keep every term &amp; permission with the drawing.");
      } else expect(bytes.includes(Buffer.from(`Copyright\0\0\0\0\0${notice}`, "utf8"))).toBe(true);
    }
    write(root, "NOTICE.md", "Updated project terms.\n");
    const updated = await app.call("export_diagram", { viewId: "flow" });
    expect(Buffer.from(String(updated.structured.data), "base64").toString("utf8")).toContain("Updated project terms.");
    rmSync(`${root}/NOTICE.md`);
    const plain = await app.call("export_diagram", { viewId: "flow" });
    expect(Buffer.from(String(plain.structured.data), "base64").toString("utf8")).not.toContain(
      "archer-project-notice",
    );
  } finally {
    app.close();
  }
});

test("a project notice cannot read through a symlink outside the project", async () => {
  const root = project(),
    outside = tempDir("archer-notice-outside-");
  write(outside, "NOTICE.md", "Private outside terms.");
  symlinkSync(`${outside}/NOTICE.md`, `${root}/NOTICE.md`);
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    await expect(app.call("export_diagram", { viewId: "flow" })).rejects.toMatchObject({
      data: { code: "export_notice_invalid" },
    });
  } finally {
    app.close();
  }
});

test.skipIf(process.platform === "win32")(
  "a FIFO notice is refused promptly without blocking export",
  async () => {
    const root = project();
    const made = spawnSync("mkfifo", [`${root}/NOTICE.md`]);
    expect(made.status, made.stderr?.toString()).toBe(0);
    const module = new URL("../../src/application/index.ts", import.meta.url).href;
    const exportModule = new URL("../../src/application/export.ts", import.meta.url).href;
    const script = `import { createApplication } from ${JSON.stringify(module)};
    await import(${JSON.stringify(exportModule)});
    const app = createApplication({ cwd: ${JSON.stringify(root)}, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
    await app.call("read_diagram", { viewId: "flow" });
    process.send("compiled before notice read");
    try { await app.call("export_diagram", { viewId: "flow" }); process.exitCode = 1; }
    catch (error) { if (error.data?.code !== "export_notice_invalid") { console.error(error); process.exitCode = 2; } }
    finally { app.close(); process.disconnect(); }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const initialized = once(child, "message"),
      exited = once(child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined,
      stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const within = <T>(promise: Promise<T>, milliseconds: number) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Notice export blocked: ${stderr}`)), milliseconds);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
    try {
      expect((await within(initialized, 25000))[0]).toBe("compiled before notice read");
      expect((await within(exited, 1000))[0], stderr).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  },
  30000,
);

test.each(["invalid UTF-8", "invalid XML text", "oversized", "directory"])(
  "a %s notice refuses export instead of dropping its terms",
  async (kind) => {
    const root = project(),
      path = `${root}/NOTICE.md`;
    if (kind === "invalid UTF-8") writeFileSync(path, Buffer.from([0xff, 0xfe]));
    else if (kind === "invalid XML text") writeFileSync(path, "Copyright\0Terms");
    else if (kind === "oversized") writeFileSync(path, "x".repeat(100001));
    else mkdirSync(path);
    const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
    try {
      await expect(app.call("export_diagram", { viewId: "flow" })).rejects.toMatchObject({
        data: { code: "export_notice_invalid" },
      });
    } finally {
      app.close();
    }
  },
);

test("a notice at the byte limit retains its complete final terms", async () => {
  const root = project(),
    notice = `${"x".repeat(99988)}Final terms.`;
  expect(Buffer.byteLength(notice)).toBe(100000);
  write(root, "NOTICE.md", notice);
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    const result = await app.call("export_diagram", { viewId: "flow" });
    const svg = Buffer.from(String(result.structured.data), "base64").toString("utf8");
    expect(svg.includes(`<metadata id="archer-project-notice">${notice}</metadata>`)).toBe(true);
  } finally {
    app.close();
  }
});

test("the public export operation can request a visible project-notice caption", async () => {
  const root = project();
  write(root, "NOTICE.md", "Full visible project terms.");
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    const plain = await app.call("export_diagram", { viewId: "flow" });
    const captioned = await app.call("export_diagram", { viewId: "flow", noticeCaption: true });
    const svg = Buffer.from(String(captioned.structured.data), "base64").toString("utf8");
    expect(svg.includes('data-export-notice="true"')).toBe(true);
    expect(captioned.structured.height).toBeGreaterThan(Number(plain.structured.height));
  } finally {
    app.close();
  }
});

test("a project notice cannot disclose another file through a hard link", async () => {
  const root = project(),
    outside = tempDir("archer-notice-hardlink-");
  write(outside, "NOTICE.md", "Private outside terms.");
  linkSync(`${outside}/NOTICE.md`, `${root}/NOTICE.md`);
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    await expect(app.call("export_diagram", { viewId: "flow" })).rejects.toMatchObject({
      data: { code: "export_notice_invalid" },
    });
  } finally {
    app.close();
  }
});
