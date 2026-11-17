// Revocation ends the grant's open event streams by the time revoke returns (security rubric R1,
// probe P7; ADR 0017): every stream the grant holds, by Bearer, by cookie, or as a paired device,
// has ended once `revokeAccess` answers (allowing only the transit of the already-sent end), not at
// the next heartbeat (KEEP_ALIVE_MS) or event. Other grants' and the owner's streams stay open.
import { afterEach, expect, test } from "vitest";
import { openStream } from "../../../tools/devkit/security/lib/client.mjs";
import { KEEP_ALIVE_MS } from "../../src/service/http.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, project, service, slugOf } from "./support.ts";

afterEach(cleanUp);

/** How long after revoke returns an end already written may take to arrive on loopback. */
const TRANSIT_MS = 250;

test("revoking a grant has ended all its streams (Bearer, cookie, paired) when revoke returns; other streams stay open", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const streams: { close(): void }[] = [];
  try {
    const attached = await client.call("attach", { root: project() });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const events = `${origin}/p/${slug}/api/events`;
    const open = async (headers: Record<string, string>) => {
      const stream = await openStream(events, { headers });
      streams.push(stream);
      expect(stream.status).toBe(200);
      return stream;
    };
    const cookieOf = async (url: string) => ((await http(url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;

    const revoked = await client.call("issueAccess", { label: "revoked" });
    const kept = await client.call("issueAccess", { label: "kept" });
    const pairing = await client.call("issuePairingCode", {});
    const paired = await http(`${origin}/-/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(paired.status).toBe(303);
    const pairedCookie = (paired.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const pairedGrant = (await client.call("listAccess", {})).grants.find((grant) => grant.label.startsWith("Paired"))!;

    const bearer = await open({ authorization: `Bearer ${revoked.token}` });
    const cookie = await open({ cookie: await cookieOf(revoked.url) });
    const device = await open({ cookie: pairedCookie });
    const other = await open({ authorization: `Bearer ${kept.token}` });
    const owner = await open({ cookie: await cookieOf(svc.homeUrl) });

    expect(await client.call("revokeAccess", { grantId: revoked.id })).toEqual({ revoked: true });
    const returned = Date.now();
    expect(await client.call("revokeAccess", { grantId: pairedGrant.id })).toEqual({ revoked: true });
    const returnedPaired = Date.now();
    const within = (stream: { ended: Promise<number> }, ms: number) =>
      Promise.race([stream.ended, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
    const [bearerEnd, cookieEnd, deviceEnd] = await Promise.all([
      within(bearer, TRANSIT_MS),
      within(cookie, TRANSIT_MS),
      within(device, TRANSIT_MS + (returnedPaired - returned)),
    ]);
    expect({
      bearer: bearerEnd !== null && bearerEnd - returned <= TRANSIT_MS,
      cookie: cookieEnd !== null && cookieEnd - returned <= TRANSIT_MS,
      paired: deviceEnd !== null && deviceEnd - returnedPaired <= TRANSIT_MS,
    }).toEqual({ bearer: true, cookie: true, paired: true });
    expect(TRANSIT_MS).toBeLessThan(KEEP_ALIVE_MS);
    expect([other.endedAt(), owner.endedAt()]).toEqual([null, null]);
    expect((await http(events, { headers: { authorization: `Bearer ${revoked.token}` } })).status).toBe(404);
  } finally {
    streams.forEach((stream) => stream.close());
    client.close();
  }
}, 20_000);
