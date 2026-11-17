// PageServing (service/page-serving.ts): the page a service serves, read once and stamped with the version that
// serves it, with the assets it names, plus one previous build's assets (ADR 0032, page assets across an upgrade).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PageServing } from "../../src/service/page-serving.ts";
import { cleanUp, tempDir, write } from "./support.ts";

afterEach(cleanUp);

/** A built page that names its worker, as the `ui` build writes it; returns the page's path. */
function builtPage(worker: string, source: string): string {
  const dir = tempDir("archer-page-");
  write(
    dir,
    "index.html",
    `<!doctype html><html><head></head><body><script>new Worker(new URL("page-assets/${worker}",location.href))</script></body></html>`,
  );
  write(dir, `page-assets/${worker}`, source);
  write(dir, "page-assets/unnamed-AbC12345.js", "a file the page does not name");
  return join(dir, "index.html");
}

const CURRENT = "elk-layout-worker-Cur123_x.js";
const PREVIOUS = "elk-layout-worker-Pre456_y.js";

describe("PageServing", () => {
  test("the page is read once and names the version that serves it", () => {
    const path = builtPage(CURRENT, "current");
    const serving = new PageServing({ path, version: () => "9.8.7" });
    const page = serving.page();
    expect(page.toString("utf8")).toContain('<head><meta name="archer-application-version" content="9.8.7">');
    writeFileSync(path, "<html>replaced on disk</html>");
    expect(serving.page()).toBe(page);
  });

  test("an asset the page names is served from beside it; one it does not name is not", () => {
    const serving = new PageServing({ path: builtPage(CURRENT, "current"), version: () => "1" });
    expect(serving.asset(CURRENT)?.bytes.toString()).toBe("current");
    expect(serving.asset("unnamed-AbC12345.js")).toBeNull();
    expect(serving.asset("index.html")).toBeNull();
  });

  test("assets are read with the page: a worker replaced afterwards is still the one the page named", () => {
    const path = builtPage(CURRENT, "current");
    const serving = new PageServing({ path, version: () => "1" });
    serving.page();
    writeFileSync(join(path, "..", "page-assets", CURRENT), "rebuilt");
    expect(serving.asset(CURRENT)?.bytes.toString()).toBe("current");
  });

  test("an unreadable page serves no asset", () => {
    const serving = new PageServing({ path: join(tempDir(), "missing.html"), version: () => "1" });
    expect(() => serving.page()).toThrow();
    expect(serving.asset(CURRENT)).toBeNull();
  });

  test("the previous build's assets are served too, and named as the retained page", () => {
    const previous = builtPage(PREVIOUS, "previous");
    const serving = new PageServing({
      path: builtPage(CURRENT, "current"),
      previousPagePath: previous,
      version: () => "1",
    });
    expect(serving.retainedPage).toBe(previous);
    expect(serving.asset(PREVIOUS)?.bytes.toString()).toBe("previous");
    expect(serving.asset(CURRENT)?.bytes.toString()).toBe("current");
  });

  test("a same-build restart keeps the page the previous service retained", () => {
    const own = builtPage(CURRENT, "current");
    const retained = builtPage(PREVIOUS, "previous");
    const serving = new PageServing({
      path: own,
      previousPagePath: own,
      retainedPagePath: retained,
      version: () => "1",
    });
    expect(serving.retainedPage).toBe(retained);
    expect(serving.asset(PREVIOUS)?.bytes.toString()).toBe("previous");
  });

  test("with no other build, nothing is retained", () => {
    const own = builtPage(CURRENT, "current");
    expect(new PageServing({ path: own, version: () => "1" }).retainedPage).toBeUndefined();
    expect(new PageServing({ path: own, previousPagePath: own, version: () => "1" }).retainedPage).toBeUndefined();
  });
});
