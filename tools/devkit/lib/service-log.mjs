// The sandbox service's debug log (/-/debug/log, ARCHER_DEBUG=1), read with the service's own token. The release
// check and the harness gate on its svc.* warnings, so a log that cannot be read is reported with its cause and
// never passes as an empty list (O5: a token the sandbox could not read hid every svc.* warning for a pass).

/**
 * One read of `/-/debug/log?<query>`: `{seq, entries}`, or `{unreadable}` naming why there is no answer.
 * `token` is the sandbox record's `ownerToken`.
 */
export async function readServiceLog(origin, token, query, { timeoutMs = 5000 } = {}) {
  if (!token) return { unreadable: "no service token (the sandbox record has no ownerToken)" };
  let res;
  try {
    res = await fetch(`${origin}/-/debug/log?${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return { unreadable: `GET /-/debug/log failed: ${error.cause?.message ?? error.message}` };
  }
  if (!res.ok)
    return {
      unreadable: `GET /-/debug/log answered ${res.status}${res.status === 404 ? " (not the service's own token, or no ARCHER_DEBUG=1)" : ""}`,
    };
  try {
    const body = await res.json();
    if (!Array.isArray(body?.entries)) return { unreadable: "GET /-/debug/log answered without an entries list" };
    return { seq: typeof body.seq === "number" ? body.seq : null, entries: body.entries };
  } catch (error) {
    return { unreadable: `GET /-/debug/log answered unreadable JSON: ${error.message}` };
  }
}
