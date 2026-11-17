import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

test("native HTTPS exchanges a secure remembered cookie and authorizes browser writes", async ({ browser }) => {
  const project = await startTsProject({
    https: true,
    pagePath: testPage(),
    files: {
      "archer.toml": 'version=1\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource=".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n  a[Client] e1@--> b[API]\n",
    },
  });
  // Isolated browser fixture only. Node below independently verifies CA and hostname;
  // no process/global verification bypass or operating-system trust change is used.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const grant = await project.issueAccess("HTTPS browser");
    const origin = new URL(grant.url).origin;
    const verified = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${origin}/api/connection`,
        { ca: readFileSync(project.caCert!), headers: { authorization: `Bearer ${grant.token}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(verified).toBe(200);
    const page = await context.newPage();
    await page.goto(grant.url);
    await expect(page).toHaveURL(`${origin}/projects/`);
    await expect(page.getByRole("searchbox", { name: "Search projects and files" })).toBeVisible();
    const cookie = (await context.cookies()).find((cookie) => cookie.name.startsWith("__Host-archer-"));
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    await page.reload();
    await expect(page.getByRole("searchbox")).toBeVisible();
    const slug = new URL(project.url).pathname.split("/")[2]!;
    const saved = await page.evaluate(
      async ({ slug }) => {
        const response = await fetch(`/p/${slug}/api/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // A comment operation, as the page sends it (ADR 0016).
          body: JSON.stringify({
            operation: {
              id: [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""),
              issuedAt: Date.now(),
              name: "comment.create",
              target: "view:flow",
            },
            payload: { target: "view:flow", anchor: { kind: "view" }, body: "HTTPS browser comment" },
          }),
        });
        return response.status;
      },
      { slug },
    );
    expect(saved).toBe(200);
    await project.revokeAccess(grant.id);
    expect((await page.request.get(`${origin}/api/projects`)).status()).toBe(404);
  } finally {
    await context.close();
    await project.stop();
  }
});
